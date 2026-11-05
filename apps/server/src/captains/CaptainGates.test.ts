import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type Captain,
  type CaptainMcpOrderCreateInput,
  type CaptainOrder,
  type CaptainOrderId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as CaptainService from "./CaptainService.ts";
import { type CaptainHarness, captainThreadId, makeHarness, shell } from "./Captain.testkit.ts";

const order = (
  fields: Partial<CaptainMcpOrderCreateInput> & Pick<CaptainMcpOrderCreateInput, "title">,
): CaptainMcpOrderCreateInput => ({
  brief: `Do ${fields.title}.`,
  kind: "change",
  touches: [`${fields.title}/`],
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

const crewThread = (found: CaptainOrder) => {
  assert.isNotNull(found.threadId);
  return found.threadId as ThreadId;
};

const reportDone = (found: CaptainOrder) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    return yield* captains.crewReport({
      threadId: crewThread(found),
      report: { status: "done", summary: `${found.title} is done.` },
    });
  });

const worktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "captain-gates-" });
});

const withWorktree = <A, E, R>(
  options: Parameters<typeof makeHarness>[0],
  body: (harness: CaptainHarness, dir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* worktree;
    const harness = makeHarness({ ...options, worktreeDir: dir });
    return yield* body(harness, dir).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer));

const noteTexts = (subscription: PubSub.Subscription<CaptainService.CrewSignal>) =>
  PubSub.takeUpTo(subscription, 1_000).pipe(
    Effect.map((signals) =>
      [...signals].flatMap((signal) => (signal.kind === "note" ? [signal.text] : [])),
    ),
  );

const sentTo = (harness: CaptainHarness, threadId: ThreadId) =>
  harness.sends.filter((send) => send.threadId === threadId).map((send) => send.text);

it.effect(
  "a failed done-check sends the crew back once with the log, then a pass moves a change to review",
  () =>
    withWorktree({}, (harness, dir) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const fileSystem = yield* FileSystem.FileSystem;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;
        const created = yield* create(
          captain,
          order({ title: "readme", doneCheck: "test -f DONE" }),
        );
        const crew = crewThread(created);

        const reported = yield* reportDone(created);
        assert.equal(reported.state, "verifying");
        yield* captains.drain;

        const failed = yield* find(captain, created.id);
        assert.equal(failed.state, "running");
        assert.equal(failed.retries, 1);
        assert.equal(failed.verify?.cmd, "test -f DONE");
        assert.equal(failed.verify?.exit, 1);
        const sent = sentTo(harness, crew);
        assert.equal(sent.length, 1);
        assert.include(
          sent[0] ?? "",
          "The done-check failed. Fix it and call crew_report done again.",
        );
        assert.include(sent[0] ?? "", "Command: test -f DONE");
        assert.include(sent[0] ?? "", "Exit code: 1");
        assert.deepEqual(
          (yield* noteTexts(signals)).filter((text) => text.startsWith("verify")),
          ["verify failed (exit 1), sent back"],
        );

        yield* fileSystem.writeFileString(`${dir}/DONE`, "ok");
        yield* reportDone(failed);
        yield* captains.drain;

        const passed = yield* find(captain, created.id);
        assert.equal(passed.state, "reviewing");
        assert.equal(passed.verify?.exit, 0);
        assert.isNotNull(passed.review);
        assert.include(yield* noteTexts(signals), "verify passed");
        assert.equal(sentTo(harness, crew).length, 1);
      }),
    ),
);

it.effect("a second failed check stops sending the crew back and asks the captain", () =>
  withWorktree({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const signals = yield* captains.subscribeSignals;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme", doneCheck: "exit 7" }));

      yield* reportDone(created);
      yield* captains.drain;
      yield* reportDone(yield* find(captain, created.id));
      yield* captains.drain;

      const stuck = yield* find(captain, created.id);
      assert.equal(stuck.state, "verify_failed");
      assert.equal(stuck.retries, 2);
      assert.equal(stuck.verify?.exit, 7);
      assert.equal(sentTo(harness, crewThread(created)).length, 1);
      const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
      assert.deepEqual(
        open.map((escalation) => [escalation.kind, escalation.orderId]),
        [["retry_limit", created.id]],
      );
      assert.include(open[0]?.detail ?? "", "Command: exit 7");
      assert.include(yield* noteTexts(signals), "verify failed twice, needs you");

      yield* captains.drain;
      assert.equal((yield* captains.listEscalations({ captainId: captain.id })).length, 1);
    }),
  ),
);

it.effect("a report order with a done-check ends done, and its dependents are admitted", () =>
  withWorktree({}, () =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const signals = yield* captains.subscribeSignals;
      const captain = yield* makeCaptain;
      const checked = yield* create(
        captain,
        order({ title: "bench", kind: "report", touches: [], doneCheck: "true" }),
      );
      const unchecked = yield* create(
        captain,
        order({ title: "notes", kind: "report", touches: [] }),
      );

      assert.equal((yield* reportDone(checked)).state, "verifying");
      assert.equal((yield* reportDone(unchecked)).state, "done");
      yield* captains.drain;

      const finished = yield* find(captain, checked.id);
      assert.equal(finished.state, "done");
      assert.equal(finished.verify?.exit, 0);
      assert.isNull(finished.review);
      assert.include(yield* noteTexts(signals), "verify passed");
    }),
  ),
);

it.effect("re-runs a verification that was claimed when the server stopped", () =>
  withWorktree({}, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme", doneCheck: "true" }));
      yield* reportDone(created);
      yield* captains.drain;
      assert.equal((yield* find(captain, created.id)).state, "reviewing");

      yield* sql`UPDATE captain_orders
        SET state = 'verifying', verify_json = NULL, claimed_at = '2026-11-05T00:00:00.000Z'
        WHERE order_id = ${created.id}`;
      assert.equal((yield* find(captain, created.id)).state, "verifying");
      yield* captains.drain;
      assert.equal((yield* find(captain, created.id)).state, "verifying");

      const context = yield* Layer.build(Layer.fresh(CaptainService.layer));
      const restarted = Context.get(context, CaptainService.CaptainService);
      yield* restarted.drain;
      const rerun = yield* find(captain, created.id);
      assert.equal(rerun.state, "reviewing");
      assert.equal(rerun.verify?.exit, 0);
    }),
  ),
);

it.effect(
  "starts a reviewer on another provider, grouped under the crew, with the diff and AGENTS.md",
  () =>
    withWorktree({}, (harness, dir) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(`${dir}/AGENTS.md`, "Never touch the database.");
        const captain = yield* makeCaptain;
        const created = yield* create(
          captain,
          order({ title: "readme", brief: "Juice up the README." }),
        );
        yield* reportDone(created);
        yield* captains.drain;

        const reviewing = yield* find(captain, created.id);
        assert.equal(reviewing.state, "reviewing");
        assert.equal(reviewing.review?.round, 1);
        assert.deepEqual(reviewing.review?.model, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        });
        assert.isFalse(reviewing.review?.sameProvider);
        const launch = harness.launches.find(
          (candidate) => candidate.threadId === reviewing.review?.threadId,
        );
        assert.isDefined(launch);
        assert.equal(launch?.groupedUnderThreadId, crewThread(created));
        assert.equal(launch?.createdBy, "agent");
        assert.deepEqual(launch?.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: dir,
          branch: created.branch ?? undefined,
        });
        const text = launch?.initialMessage?.text ?? "";
        assert.include(text, "Juice up the README.");
        assert.include(text, "diff --git a/README.md b/README.md");
        assert.include(text, "Never touch the database.");
        assert.include(text, "review_submit");
        const entry = yield* captains.roleOf(reviewing.review!.threadId);
        assert.equal(entry?.role, "reviewer");
      }),
    ),
);

it.effect("reviews on a different model of the same provider when it is the only one", () =>
  withWorktree(
    {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.5" }],
        },
      ],
    },
    () =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));
        yield* reportDone(created);
        yield* captains.drain;
        const reviewing = yield* find(captain, created.id);
        assert.deepEqual(reviewing.review?.model, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        });
        assert.isTrue(reviewing.review?.sameProvider);
      }),
  ),
);

it.effect("uses the charter's review model when it names one", () =>
  withWorktree({}, (harness) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      yield* sql`UPDATE captains
        SET charter_json = json_set(charter_json, '$.reviewModel', json('{"instanceId":"codex","model":"gpt-5.5-mini"}'))
        WHERE captain_id = ${captain.id}`;
      const configured = Option.getOrThrow(yield* captains.get(captain.id));
      const created = yield* create(configured, order({ title: "readme" }));
      yield* reportDone(created);
      yield* captains.drain;
      const reviewing = yield* find(configured, created.id);
      assert.deepEqual(reviewing.review?.model, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.5-mini",
      });
      assert.isTrue(reviewing.review?.sameProvider);
      assert.equal(harness.launches.length, 2);
    }),
  ),
);

it.effect(
  "a rejected review goes back to the crew, and the second review checks the findings first, then accepts",
  () =>
    withWorktree({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme", touches: ["README.md"] }));
        const queued = yield* create(
          captain,
          order({ title: "readme-two", touches: ["README.md"] }),
        );
        assert.equal(queued.state, "queued");
        yield* reportDone(created);
        yield* captains.drain;

        const first = yield* find(captain, created.id);
        const firstReviewer = first.review!.threadId;
        const rejected = yield* captains.submitReview({
          threadId: firstReviewer,
          review: {
            verdict: "reject",
            findings: [{ severity: "high", file: "README.md", line: 3, scenario: "Link 404s." }],
          },
        });
        assert.equal(rejected.state, "running");
        const afterReject = yield* find(captain, created.id);
        assert.equal(afterReject.state, "running");
        assert.equal(afterReject.retries, 1);
        assert.equal(afterReject.review?.verdict, "reject");
        assert.equal((yield* find(captain, queued.id)).state, "queued");
        const sent = sentTo(harness, crewThread(created));
        assert.equal(sent.length, 1);
        assert.include(sent[0] ?? "", "[high] README.md:3: Link 404s.");
        assert.equal(yield* captains.roleOf(firstReviewer), undefined);

        yield* reportDone(afterReject);
        yield* captains.drain;
        const second = yield* find(captain, created.id);
        assert.equal(second.state, "reviewing");
        assert.equal(second.review?.round, 2);
        assert.notEqual(second.review?.threadId, firstReviewer);
        assert.equal(second.review?.previousFindings.length, 1);
        const launch = harness.launches.find(
          (candidate) => candidate.threadId === second.review?.threadId,
        );
        assert.include(launch?.initialMessage?.text ?? "", "Check each of them first");
        assert.include(launch?.initialMessage?.text ?? "", "Link 404s.");

        const accepted = yield* captains.submitReview({
          threadId: second.review!.threadId,
          review: { verdict: "approve", findings: [] },
        });
        assert.equal(accepted.state, "accepted");
        assert.equal((yield* find(captain, created.id)).state, "accepted");
        assert.equal((yield* find(captain, queued.id)).state, "running");
        assert.deepEqual(
          (yield* noteTexts(signals)).filter((text) => /^(review|accepted)/.test(text)),
          ["review rejected (1 finding), sent back", "accepted (reviewed by claude-opus-5-5)"],
        );
      }),
    ),
);

it.effect(
  "a review rejected past the retry limit opens an escalation instead of sending the crew back",
  () =>
    withWorktree({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));
        const reject = (threadId: ThreadId) =>
          captains.submitReview({
            threadId,
            review: {
              verdict: "reject",
              findings: [{ severity: "medium", file: "README.md", scenario: "Typo." }],
            },
          });
        yield* reportDone(created);
        yield* captains.drain;
        yield* reject((yield* find(captain, created.id)).review!.threadId);
        yield* reportDone(yield* find(captain, created.id));
        yield* captains.drain;
        const result = yield* reject((yield* find(captain, created.id)).review!.threadId);

        assert.equal(result.state, "verify_failed");
        assert.equal(sentTo(harness, crewThread(created)).length, 1);
        const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
        assert.deepEqual(
          open.map((escalation) => escalation.kind),
          ["retry_limit"],
        );
        assert.equal((yield* find(captain, created.id)).state, "verify_failed");
      }),
    ),
);

it.effect("asks a silent reviewer once more, then hands the decision to the captain", () =>
  withWorktree({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const signals = yield* captains.subscribeSignals;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme" }));
      yield* reportDone(created);
      yield* captains.drain;
      const reviewer = (yield* find(captain, created.id)).review!.threadId;

      yield* captains.reviewerEnded(reviewer);
      assert.equal(sentTo(harness, reviewer).length, 1);
      assert.include(sentTo(harness, reviewer)[0] ?? "", "review_submit");
      assert.isTrue((yield* find(captain, created.id)).review?.reprompted);
      assert.deepEqual(yield* captains.listEscalations({ captainId: captain.id }), []);

      yield* captains.reviewerEnded(reviewer);
      assert.equal(sentTo(harness, reviewer).length, 1);
      const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
      assert.deepEqual(
        open.map((escalation) => escalation.kind),
        ["decision"],
      );
      assert.include(yield* noteTexts(signals), `needs you: ${open[0]?.summary}`);
      assert.equal((yield* find(captain, created.id)).state, "reviewing");
    }),
  ),
);

it.effect("only the live reviewer of a reviewing order can submit a verdict", () =>
  withWorktree({}, () =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme" }));
      const approve = { verdict: "approve", findings: [] } as const;
      const fromCrew = yield* captains
        .submitReview({ threadId: crewThread(created), review: approve })
        .pipe(Effect.flip);
      assert.equal(fromCrew.reason, "not_reviewer");
      yield* reportDone(created);
      yield* captains.drain;
      const reviewer = (yield* find(captain, created.id)).review!.threadId;
      yield* captains.submitReview({ threadId: reviewer, review: approve });
      const again = yield* captains
        .submitReview({ threadId: reviewer, review: approve })
        .pipe(Effect.flip);
      assert.equal(again.reason, "not_reviewer");
    }),
  ),
);

it.effect(
  "a captain's escalation is listed, quiet until resolved, and resolving it wakes the captain",
  () =>
    withWorktree({}, () =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));
        const opened = yield* captains.escalate({
          captain,
          orderId: created.id,
          kind: "one_way_door",
          summary: "Delete the old API?",
          detail: "It breaks two clients.",
          options: ["delete", "keep"],
        });
        assert.equal(opened.status, "open");
        assert.deepEqual(opened.options, ["delete", "keep"]);
        assert.deepEqual(yield* noteTexts(signals), []);
        assert.deepEqual(yield* captains.needsYouOf(captain.threadId), {
          count: 1,
          summary: "Delete the old API?",
        });
        assert.deepEqual(
          (yield* captains.listEscalations({ captainId: captain.id })).map(
            (escalation) => escalation.id,
          ),
          [opened.id],
        );
        assert.equal(
          (yield* captains.escalate({
            captain,
            orderId: created.id,
            kind: "one_way_door",
            summary: "Delete the old API?",
            detail: undefined,
            options: undefined,
          })).id,
          opened.id,
        );

        const resolved = yield* captains.resolveEscalation({
          escalationId: opened.id,
          resolution: "keep",
        });
        assert.equal(resolved.status, "resolved");
        assert.equal(resolved.resolution, "keep");
        assert.isNull(yield* captains.needsYouOf(captain.threadId));
        assert.isNull(yield* captains.needsYouOf("thread:not-a-captain" as ThreadId));
        assert.deepEqual(yield* noteTexts(signals), ["you resolved: Delete the old API? → keep"]);
        assert.deepEqual(
          yield* captains.listEscalations({ captainId: captain.id, status: "open" }),
          [],
        );

        const twice = yield* captains
          .resolveEscalation({ escalationId: opened.id, resolution: "delete" })
          .pipe(Effect.flip);
        assert.equal(twice.reason, "invalid_state");
        const unknown = yield* captains
          .resolveEscalation({ escalationId: "escalation:nope" as never, resolution: "x" })
          .pipe(Effect.flip);
        assert.equal(unknown.reason, "escalation_not_found");
      }),
    ),
);

it.effect("answering an order sends the crew the answer and resolves its open decision", () =>
  withWorktree({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const signals = yield* captains.subscribeSignals;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme" }));
      const other = yield* create(captain, order({ title: "bench" }));
      yield* captains.openEscalation({
        captainId: captain.id,
        orderId: created.id,
        kind: "decision",
        summary: "readme: which license?",
        detail: "",
        options: [],
        wake: true,
      });
      yield* captains.openEscalation({
        captainId: captain.id,
        orderId: other.id,
        kind: "decision",
        summary: "bench: which dataset?",
        detail: "",
        options: [],
        wake: true,
      });
      assert.deepEqual(yield* noteTexts(signals), [
        "needs you: readme: which license?",
        "needs you: bench: which dataset?",
      ]);

      const answered = yield* captains.answerOrder({
        captain,
        orderId: created.id,
        text: "MIT.",
      });
      assert.equal(answered.resolved, 1);
      assert.deepEqual(sentTo(harness, crewThread(created)), ["MIT."]);
      const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
      assert.deepEqual(
        open.map((escalation) => escalation.orderId),
        [other.id],
      );
    }),
  ),
);

it.effect(
  "a crew approval resolves into the runtime request response, and refuses other answers",
  () =>
    withWorktree({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));
        const escalation = yield* captains.openEscalation({
          captainId: captain.id,
          orderId: created.id,
          kind: "approval",
          summary: "readme needs approval: rm -rf build",
          detail: "",
          options: ["approve", "deny"],
          requestId: "request:a",
          wake: true,
        });

        const unclear = yield* captains
          .resolveEscalation({ escalationId: escalation.id, resolution: "hmm" })
          .pipe(Effect.flip);
        assert.equal(unclear.reason, "invalid_state");
        assert.equal(
          harness.commands.filter((command) => command.type === "runtime-request.respond").length,
          0,
        );

        yield* captains.resolveEscalation({ escalationId: escalation.id, resolution: "deny" });
        const responses = harness.commands.flatMap((command) =>
          command.type === "runtime-request.respond" ? [command] : [],
        );
        assert.equal(responses.length, 1);
        assert.equal(responses[0]?.requestId, "request:a");
        assert.equal(responses[0]?.threadId, crewThread(created));
        assert.equal(responses[0]?.decision, "decline");
      }),
    ),
);

it.effect(
  "flags a crew that has done nothing for a stall window, escalates the second, and resets on activity",
  () =>
    withWorktree({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));
        const crew = crewThread(created);

        yield* TestClock.adjust("44 minutes");
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 0);

        yield* TestClock.adjust("1 minute");
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 1);
        assert.include(yield* noteTexts(signals), "stalled for 45m");
        assert.deepEqual(yield* captains.listEscalations({ captainId: captain.id }), []);

        yield* captains.touchActivity(created.id);
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 0);

        yield* TestClock.adjust("45 minutes");
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 1);
        yield* TestClock.adjust("45 minutes");
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 2);
        const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
        assert.deepEqual(
          open.map((escalation) => escalation.kind),
          ["stall"],
        );
        yield* captains.drain;
        assert.equal(
          (yield* captains.listEscalations({ captainId: captain.id, status: "open" })).length,
          1,
        );
        assert.equal(harness.shells.has(crew), true);
      }),
    ),
);

it.effect(
  "does not count time a crew spends on its own background command, pull request or approval",
  () =>
    withWorktree({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "readme" }));
        const crew = crewThread(created);
        const waiting = {
          ...shell(crew),
          pendingBackgroundTasks: [{ id: "task:build" }],
        } as never;
        harness.shells.set(crew, waiting);

        yield* TestClock.adjust("3 hours");
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 0);
        assert.deepEqual(yield* captains.listEscalations({ captainId: captain.id }), []);

        harness.shells.set(crew, shell(crew));
        yield* TestClock.adjust("1 minute");
        yield* captains.drain;
        assert.equal((yield* find(captain, created.id)).stallLevel, 2);
      }),
    ),
);

it.effect(
  "retrying an order restarts the crew in its worktree with the new brief and counts a retry",
  () =>
    withWorktree({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* makeCaptain;
        const created = yield* create(
          captain,
          order({ title: "readme", brief: "Original brief." }),
        );
        const crew = crewThread(created);

        const retried = yield* captains.retryOrder({
          captain,
          orderId: created.id,
          brief: "Revised brief.",
        });
        assert.equal(retried.state, "running");
        assert.equal(retried.retries, 1);
        assert.deepEqual(
          harness.interrupts.map((interrupt) => interrupt.threadId),
          [crew],
        );
        assert.include(sentTo(harness, crew)[0] ?? "", "Revised brief.");
        assert.equal((yield* find(captain, created.id)).threadId, crew);

        yield* captains.retryOrder({ captain, orderId: created.id, brief: undefined });
        assert.include(sentTo(harness, crew)[1] ?? "", "Original brief.");
        assert.equal((yield* find(captain, created.id)).retries, 2);

        const queued = yield* create(captain, order({ title: "second", touches: ["readme/"] }));
        assert.equal(queued.state, "queued");
        const refused = yield* captains
          .retryOrder({ captain, orderId: queued.id, brief: undefined })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "invalid_state");
      }),
    ),
);

it.effect("retrying an order under review stops its reviewer and puts the crew back to work", () =>
  withWorktree({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme" }));
      yield* reportDone(created);
      yield* captains.drain;
      const reviewer = (yield* find(captain, created.id)).review!.threadId;

      yield* captains.retryOrder({ captain, orderId: created.id, brief: undefined });

      assert.equal((yield* find(captain, created.id)).state, "running");
      assert.deepEqual(
        harness.interrupts.map((interrupt) => interrupt.threadId).toSorted(),
        [crewThread(created), reviewer].toSorted(),
      );
      assert.equal(yield* captains.roleOf(reviewer), undefined);
      const stale = yield* captains
        .submitReview({ threadId: reviewer, review: { verdict: "approve", findings: [] } })
        .pipe(Effect.flip);
      assert.equal(stale.reason, "not_reviewer");
    }),
  ),
);

it.effect("keeps the claim on a review in flight, so a pass does not start a second reviewer", () =>
  withWorktree({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "readme" }));
      yield* reportDone(created);
      yield* captains.drain;
      yield* captains.drain;
      yield* captains.drain;
      assert.equal(
        harness.launches.filter((launch) => launch.title?.startsWith("Review")).length,
        1,
      );
    }),
  ),
);
