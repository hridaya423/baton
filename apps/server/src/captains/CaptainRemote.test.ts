import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type Captain,
  type CaptainMcpOrderCreateInput,
  type CaptainOrder,
  type CaptainOrderId,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as PeerForwarding from "../peer/PeerForwarding.ts";
import { type CaptainHarness, captainThreadId, makeHarness } from "./Captain.testkit.ts";
import * as CaptainService from "./CaptainService.ts";
import { REMOTE_RETRY_MS } from "./RemoteOrders.ts";

const localEnvironmentId = EnvironmentId.make("environment:captain-test");
const miniId = EnvironmentId.make("environment:mini");
const miniProjectId = ProjectId.make("project:mini-app");
const miniThreadId = ThreadId.make("thread:mini-crew");
const repositoryKey = "github.com/acme/app";
const firstRun = RunId.make("run:mini:1");
const pushedSha = "fedcba9876543210fedcba9876543210fedcba98";

interface Call {
  readonly tool: string;
  readonly params: Record<string, unknown>;
}

interface Check {
  readonly exit: number | null;
  readonly logTail: string;
}

type LinkStatus = "reachable" | "unreachable" | "expired";

const makeMachine = (options: { readonly access?: "full-access" | "read-only" } = {}) =>
  Effect.gen(function* () {
    const outcomes = yield* Queue.unbounded<"completed" | "failed" | "interrupted">();
    const calls: Array<Call> = [];
    const state = {
      status: "reachable" as LinkStatus,
      projects: [
        { id: miniProjectId, title: "app", repositoryIdentity: { canonicalKey: repositoryKey } },
      ] as Array<{
        readonly id: ProjectId;
        readonly title: string;
        readonly repositoryIdentity: { readonly canonicalKey: string };
      }>,
      activeRunId: firstRun as RunId | null,
      latestRunId: firstRun as RunId | null,
      runCount: 1,
      itemCount: 2,
      pendingRequestCount: 0,
      approvals: [] as Array<{ readonly requestId: string; readonly prompt: string }>,
      replies: new Map<RunId, string>([[firstRun, "Updated the README."]]),
      checks: [] as Array<Check>,
      diff: "diff --git a/README.md b/README.md\n+hello from the mini\n",
    };
    const thread = () => ({
      threadId: miniThreadId,
      status: state.activeRunId === null ? "idle" : "running",
      activeRunId: state.activeRunId,
      latestRunId: state.latestRunId,
      itemCount: state.itemCount,
      pendingRequestCount: state.pendingRequestCount,
      updatedAt: `2026-11-05T00:00:${String(state.itemCount).padStart(2, "0")}.000Z`,
    });

    const forwarding = {
      call: (_scope, tool, _environmentId, params) =>
        Effect.sync(() => {
          const record = params as Record<string, unknown>;
          calls.push({ tool: tool.name, params: record });
          switch (tool.name) {
            case "t3_project_list":
              return { projects: state.projects, nextCursor: null };
            case "t3_thread_launch":
              return { threadId: miniThreadId };
            case "t3_thread_send": {
              state.runCount += 1;
              const next = RunId.make(`run:mini:${state.runCount}`);
              state.activeRunId = next;
              state.latestRunId = next;
              state.itemCount += 1;
              return { threadId: miniThreadId, delivery: "started" };
            }
            case "t3_pending_request":
              return record.action === "list" ? { requestIds: [] } : {};
            case "crew_approval":
              return {
                approvals: record.decision === undefined ? state.approvals : [],
              };
            case "crew_worktree_check": {
              const check = state.checks.shift();
              return {
                head: pushedSha,
                ...(record.command === undefined || check === undefined ? {} : { check }),
                ...(record.baseRef === undefined ? {} : { diff: { text: state.diff } }),
              };
            }
            case "crew_worktree_push":
              return { outcome: "pushed", rewrote: false };
            default:
              throw new Error(`unscripted tool ${tool.name}`);
          }
        }) as never,
      readThread: (_scope, _environmentId, input) =>
        Effect.sync(() => ({
          thread: thread(),
          items:
            input.view === "messages"
              ? [...state.replies].map(([runId, text], index) => ({
                  position: index,
                  type: "assistant_message",
                  runId,
                  itemId: `item:${runId}`,
                  text,
                  textTruncated: false,
                }))
              : [],
          hasMore: false,
          nextPosition: null,
        })) as never,
      waitForThread: (_scope, _environmentId, input) =>
        Queue.take(outcomes).pipe(
          Effect.map((status) => ({
            threadId: miniThreadId,
            runId: input.runId ?? null,
            status,
            timedOut: false,
          })),
        ) as never,
      interruptThread: (_scope, _environmentId, input) =>
        Effect.sync(() => {
          calls.push({ tool: "t3_thread_interrupt", params: { ...input } });
          return { threadId: miniThreadId, runId: null, status: "interrupt_requested" };
        }) as never,
      links: () =>
        Effect.sync(() => ({
          environmentId: localEnvironmentId,
          links: [
            {
              environmentId: miniId,
              label: "Mac mini",
              status: state.status,
              access: options.access ?? "full-access",
              expiresAt: "2026-12-05T00:00:00.000Z",
              lastError: null,
            },
          ],
          notListed: "",
        })) as never,
    } satisfies PeerForwarding.PeerForwarding["Service"];

    const finish = (status: "completed" | "failed" | "interrupted", reply?: string) =>
      Effect.gen(function* () {
        const runId = state.activeRunId;
        if (runId !== null && reply !== undefined) state.replies.set(runId, reply);
        state.activeRunId = null;
        state.itemCount += 1;
        yield* Queue.offer(outcomes, status);
      });

    return {
      forwarding,
      calls,
      state,
      finish,
      callsTo: (tool: string) => calls.filter((call) => call.tool === tool),
    };
  });

type Machine = Effect.Success<ReturnType<typeof makeMachine>>;

const attach = (machine: Machine) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    yield* captains.attachRemote({
      forwarding: machine.forwarding,
      environmentId: localEnvironmentId,
      repositoryKeyOf: () => Effect.succeed(repositoryKey),
    });
  });

const withMachine = <A, E, R>(
  options: Parameters<typeof makeHarness>[0],
  body: (harness: CaptainHarness, machine: Machine) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const harness = makeHarness({ ...options, worktreeDir: "/repo" });
    const machine = yield* makeMachine();
    return yield* Effect.gen(function* () {
      yield* attach(machine);
      return yield* body(harness, machine);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer));

const order = (
  fields: Partial<CaptainMcpOrderCreateInput> & Pick<CaptainMcpOrderCreateInput, "title">,
): CaptainMcpOrderCreateInput => ({
  brief: `Do ${fields.title}.`,
  kind: "change",
  touches: [`${fields.title}/`],
  placement: { environmentId: miniId },
  ...fields,
});

const makeCaptain = Effect.gen(function* () {
  const captains = yield* CaptainService.CaptainService;
  return yield* captains.create({ threadId: captainThreadId });
});

const create = (captain: Captain, input: CaptainMcpOrderCreateInput) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    return (yield* captains.createOrder({
      captain,
      order: input,
      runtimeModeCeiling: "full-access",
    })).order;
  });

const find = (captain: Captain, orderId: CaptainOrderId) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    const found = (yield* captains.listOrders(captain)).find(
      (candidate) => candidate.id === orderId,
    );
    assert.isDefined(found);
    return found as CaptainOrder;
  });

const noteTexts = (subscription: PubSub.Subscription<CaptainService.CrewSignal>) =>
  PubSub.takeUpTo(subscription, 1_000).pipe(
    Effect.map((signals) =>
      [...signals].flatMap((signal) => (signal.kind === "note" ? [signal.text] : [])),
    ),
  );

const untilSignal = (
  subscription: PubSub.Subscription<CaptainService.CrewSignal>,
  matches: (signal: CaptainService.CrewSignal) => boolean,
) =>
  Stream.fromSubscription(subscription).pipe(
    Stream.filter(matches),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const reported = (status: "done" | "blocked") => (signal: CaptainService.CrewSignal) =>
  signal.kind === "report" && signal.status === status;

it.effect("a remote order launches in a worktree on the other machine with the crew's brief", () =>
  withMachine({}, (harness, machine) =>
    Effect.gen(function* () {
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme", doneCheck: "pnpm test" }));

      const [launch] = machine.callsTo("t3_thread_launch");
      assert.isDefined(launch);
      const params = launch?.params as Record<string, unknown>;
      assert.equal(params.projectId, miniProjectId);
      assert.equal(params.title, "readme");
      assert.equal(params.clientRequestId, `captain-order:${created.id}:launch`);
      const strategy = params.workspaceStrategy as Record<string, unknown>;
      assert.equal(strategy.type, "worktree");
      assert.equal(strategy.baseRef, "origin/HEAD");
      assert.match(String(strategy.branch), /^crew\/evening-captain\/readme-/);
      assert.include(String(params.message), "Do readme.");
      assert.include(String(params.message), "Finishing your turn reports the order done");
      assert.include(String(params.message), "pnpm test");

      const running = yield* find(captain, created.id);
      assert.equal(running.state, "running");
      assert.equal(running.threadId, miniThreadId);
      assert.equal(running.environmentId, miniId);
      assert.equal(running.branch, strategy.branch);
      assert.lengthOf(harness.launches, 0);
    }),
  ),
);

it.effect(
  "a finished remote turn is checked there, sent back once on a failure, reviewed here from its diff, and landed by a remote push",
  () =>
    withMachine({}, (harness, machine) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;
        machine.state.checks.push(
          { exit: 1, logTail: "1 test failing" },
          { exit: 0, logTail: "all passing" },
        );
        const created = yield* create(
          captain,
          order({ title: "readme", doneCheck: "pnpm test", delivery: "branch" }),
        );

        yield* machine.finish("completed", "Rewrote the README intro.");
        const done = yield* untilSignal(signals, reported("done"));
        assert.equal(done.kind === "report" ? done.summary : "", "Rewrote the README intro.");
        yield* captains.drain;

        const sentBack = yield* find(captain, created.id);
        assert.equal(sentBack.state, "running");
        assert.equal(sentBack.retries, 1);
        assert.equal(sentBack.verify?.exit, 1);
        const [followUp] = machine.callsTo("t3_thread_send");
        assert.include(String(followUp?.params.message), "Exit code: 1");
        assert.include(String(followUp?.params.message), "1 test failing");
        const [check] = machine.callsTo("crew_worktree_check");
        assert.equal(check?.params.threadId, miniThreadId);
        assert.equal(check?.params.command, "pnpm test");

        yield* machine.finish("completed", "Fixed the failing test.");
        yield* untilSignal(signals, reported("done"));
        yield* captains.drain;

        const reviewing = yield* find(captain, created.id);
        assert.equal(reviewing.state, "reviewing");
        assert.equal(reviewing.verify?.exit, 0);
        const [reviewerLaunch] = harness.launches;
        const reviewerBrief = reviewerLaunch?.initialMessage?.text ?? "";
        assert.include(reviewerBrief, "hello from the mini");
        assert.include(reviewerBrief, "Mac mini, another machine");
        assert.equal(machine.callsTo("crew_worktree_check").length, 3);

        yield* captains.submitReview({
          threadId: reviewing.review!.threadId,
          review: { verdict: "approve", findings: [] },
        });
        yield* captains.landOrder({
          captain,
          orderId: created.id,
          delivery: undefined,
          approved: false,
        });
        yield* captains.drain;

        const landed = yield* find(captain, created.id);
        assert.equal(landed.state, "landed");
        const [push] = machine.callsTo("crew_worktree_push");
        assert.deepEqual(push?.params, { threadId: miniThreadId, branch: landed.branch });
      }),
    ),
);

it.effect(
  "an approval on the remote crew opens an escalation, and answering it forwards the decision",
  () =>
    withMachine({}, (_harness, machine) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        machine.state.pendingRequestCount = 1;
        machine.state.approvals.push({ requestId: "request:rm", prompt: "run rm -rf build" });
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "clean" }));

        yield* untilSignal(
          signals,
          (signal) => signal.kind === "note" && signal.text.startsWith("needs you"),
        );
        const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
        assert.lengthOf(open, 1);
        assert.equal(open[0]?.kind, "approval");
        assert.equal(open[0]?.requestId, "request:rm");
        assert.equal(open[0]?.orderId, created.id);

        yield* captains.resolveEscalation({ escalationId: open[0]!.id, resolution: "approve" });
        const decisions = machine.callsTo("crew_approval").filter((call) => call.params.decision);
        assert.deepEqual(decisions[0]?.params, {
          threadId: miniThreadId,
          requestId: "request:rm",
          decision: "accept",
        });
        assert.lengthOf(
          yield* captains.listEscalations({ captainId: captain.id, status: "open" }),
          0,
        );
      }),
    ),
);

it.effect(
  "an offline link keeps the order queued with one wake line, then launches when it returns",
  () =>
    withMachine({}, (_harness, machine) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        machine.state.status = "unreachable";
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));

        yield* captains.drain;
        yield* TestClock.adjust(REMOTE_RETRY_MS);
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).state, "queued");
        assert.lengthOf(machine.callsTo("t3_thread_launch"), 0);
        assert.deepEqual(
          (yield* noteTexts(signals)).filter((text) => text.startsWith("waiting")),
          ["waiting: Mac mini is offline"],
        );

        machine.state.status = "reachable";
        yield* TestClock.adjust(REMOTE_RETRY_MS);
        yield* captains.drain;
        const running = yield* find(captain, created.id);
        assert.equal(running.state, "running");
        assert.equal(running.threadId, miniThreadId);
        assert.lengthOf(machine.callsTo("t3_thread_launch"), 1);
      }),
    ),
);

it.effect(
  "a project the other machine does not have keeps the order queued and names t3_project_clone",
  () =>
    withMachine({}, (_harness, machine) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        machine.state.projects = [];
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));

        assert.equal((yield* find(captain, created.id)).state, "queued");
        const waiting = (yield* noteTexts(signals)).filter((text) => text.startsWith("waiting"));
        assert.lengthOf(waiting, 1);
        assert.include(waiting[0] ?? "", "t3_project_clone");
        assert.include(waiting[0] ?? "", miniId);
      }),
    ),
);

it.effect("a restart while a remote crew works resumes following it", () =>
  withMachine({}, (_harness, machine) =>
    Effect.gen(function* () {
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme" }));
      assert.equal((yield* find(captain, created.id)).state, "running");

      const restarted = yield* makeMachine();
      restarted.state.replies.set(firstRun, "Finished after the restart.");
      const context = yield* Layer.build(Layer.fresh(CaptainService.layer));
      const second = Context.get(context, CaptainService.CaptainService);
      const signals = yield* second.subscribeSignals;
      yield* second.attachRemote({
        forwarding: restarted.forwarding,
        environmentId: localEnvironmentId,
        repositoryKeyOf: () => Effect.succeed(repositoryKey),
      });
      yield* second.drain;
      yield* restarted.finish("completed");

      const done = yield* untilSignal(signals, reported("done"));
      assert.equal(done.kind === "report" ? done.summary : "", "Finished after the restart.");
      assert.equal((yield* find(captain, created.id)).state, "reviewing");
      assert.lengthOf(machine.callsTo("t3_thread_launch"), 1);
      assert.lengthOf(restarted.callsTo("t3_thread_launch"), 0);
    }),
  ),
);

it.effect("refuses a remote order that merges, or runs on a machine linked below full access", () =>
  withMachine({}, (_harness, machine) =>
    Effect.gen(function* () {
      const captain = yield* makeCaptain;
      const merge = yield* create(captain, order({ title: "docs", delivery: "merge" })).pipe(
        Effect.flip,
      );
      assert.equal(merge.reason, "invalid_order");
      assert.include(merge.message, "merge needs the worktree on this machine");

      const unknown = yield* create(
        captain,
        order({
          title: "docs",
          placement: { environmentId: EnvironmentId.make("environment:nope") },
        }),
      ).pipe(Effect.flip);
      assert.equal(unknown.reason, "invalid_order");
      assert.include(unknown.message, "is not linked");
      assert.lengthOf(machine.callsTo("t3_thread_launch"), 0);
    }),
  ),
);

it.effect("refuses a remote order when the link was paired below full access", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ worktreeDir: "/repo" });
    const machine = yield* makeMachine({ access: "read-only" });
    return yield* Effect.gen(function* () {
      yield* attach(machine);
      const captain = yield* makeCaptain;
      const refused = yield* create(captain, order({ title: "docs" })).pipe(Effect.flip);
      assert.equal(refused.reason, "invalid_order");
      assert.include(refused.message, "full access");
      assert.lengthOf(machine.callsTo("t3_thread_launch"), 0);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
