import { assert, it } from "@effect/vitest";
import {
  type Captain,
  type CaptainMcpOrderCreateInput,
  type CaptainOrder,
  type CaptainOrderId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";

import * as ThreadRoles from "../orchestration-v2/ThreadRoles.ts";
import * as CaptainService from "./CaptainService.ts";
import {
  type CaptainHarness,
  baseSha,
  captainThreadId,
  makeHarness,
  shell,
} from "./Captain.testkit.ts";

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
    return yield* captains.createOrder({
      captain,
      order: input,
      runtimeModeCeiling: "full-access",
    });
  });

const orderState = (captain: Captain, orderId: CaptainOrderId) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    const orders = yield* captains.listOrders(captain);
    return orders.find((candidate) => candidate.id === orderId)?.state;
  });

const crewThread = (found: CaptainOrder) => {
  assert.isNotNull(found.threadId);
  return found.threadId as ThreadId;
};

const withHarness = <A, E, R>(
  options: Parameters<typeof makeHarness>[0],
  body: (harness: CaptainHarness) => Effect.Effect<A, E, R>,
) => {
  const harness = makeHarness(options);
  return body(harness).pipe(Effect.provide(harness.layer));
};

it.effect("makes a thread a captain: pinned, no auto-settle, told what it is on every turn", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const roles = yield* ThreadRoles.ThreadRoles;
      const captain = yield* makeCaptain;
      assert.equal(captain.status, "active");
      assert.equal(captain.name, "Evening captain");
      assert.deepEqual(captain.charter, {
        crewCap: 3,
        defaultDelivery: "branch",
        crewRuntimeMode: "full-access",
        retryLimit: 1,
        stallMinutes: 45,
        verifyTimeoutMinutes: 10,
      });
      assert.deepEqual(
        harness.commands.map((command) => command.type),
        ["thread.pin", "thread.auto-settle.set"],
      );
      const settle = harness.commands[1];
      assert.isTrue(settle?.type === "thread.auto-settle.set" && settle.enabled === false);
      const entry = yield* roles.get(captainThreadId);
      assert.equal(entry?.role, "captain");
      assert.include(entry?.instructions ?? "", "order_create");
      assert.include(entry?.instructions ?? "", "order_answer");
      assert.deepEqual(yield* captains.roleOf(captainThreadId), {
        role: "captain",
        captainId: captain.id,
      });
      assert.deepEqual(
        (yield* captains.list({})).map((listed) => listed.id),
        [captain.id],
      );
    }),
  ),
);

it.effect("refuses subagents, missing threads, second captains and crew", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const reason = (threadId: ThreadId) =>
        captains.create({ threadId }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      const subagent = ThreadId.make("thread:subagent");
      harness.shells.set(subagent, shell(subagent, { subagent: true }));
      assert.equal(yield* reason(subagent), "thread_is_subagent");
      assert.equal(yield* reason(ThreadId.make("thread:missing")), "thread_not_found");
      const captain = yield* makeCaptain;
      assert.equal(yield* reason(captainThreadId), "thread_already_captain");
      const { order: started } = yield* create(captain, order({ title: "docs" }));
      assert.equal(yield* reason(crewThread(started)), "thread_is_crew");
    }),
  ),
);

it.effect("launches a report and the first change at once, holding an overlapping change", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captain = yield* makeCaptain;
      const report = yield* create(
        captain,
        order({ title: "benchmarks", kind: "report", touches: [] }),
      );
      const first = yield* create(captain, order({ title: "readme", touches: ["README.md"] }));
      const second = yield* create(
        captain,
        order({ title: "readme-demo", touches: ["README.md", "demo/**"] }),
      );
      assert.deepEqual(
        [report, first, second].map((created) => [created.order.state, created.position]),
        [
          ["running", 0],
          ["running", 0],
          ["queued", 1],
        ],
      );
      assert.equal(harness.launches.length, 2);
      const branches = harness.launches.map((launch) =>
        launch.workspaceStrategy.type === "worktree" ? launch.workspaceStrategy.branch : undefined,
      );
      assert.equal(new Set(branches).size, 2);
      for (const launch of harness.launches) {
        assert.equal(launch.groupedUnderThreadId, captainThreadId);
        assert.equal(launch.createdBy, "agent");
        assert.equal(launch.creationSource, "server");
        assert.equal(launch.runtimeMode, "full-access");
        assert.equal(launch.initialMessage?.senderThreadId, captainThreadId);
        assert.deepEqual(launch.modelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        });
        assert.equal(launch.workspaceStrategy.type, "worktree");
        assert.isTrue(
          launch.workspaceStrategy.type === "worktree" &&
            launch.workspaceStrategy.baseRef === baseSha &&
            launch.workspaceStrategy.branch?.startsWith("crew/evening-captain/") === true,
        );
        assert.notInclude(launch.initialMessage?.text ?? "", "crew_report");
      }
      const roles = yield* ThreadRoles.ThreadRoles;
      const reportRole = yield* roles.get(crewThread(report.order));
      assert.include(reportRole?.instructions ?? "", 'You are crew for captain "Evening captain"');
      assert.include(reportRole?.instructions ?? "", "(report)");
      assert.include(reportRole?.instructions ?? "", "crew_report");
      assert.equal(first.order.branch, branches[1]);
      assert.equal(first.order.baseRef, baseSha);
    }),
  ),
);

it.effect("admits the queued order when a report order's crew reports done", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const first = yield* create(captain, order({ title: "survey", kind: "report", touches: [] }));
      const second = yield* create(
        captain,
        order({ title: "readme", touches: ["README.md"], dependsOn: [first.order.id] }),
      );
      assert.equal(second.order.state, "queued");
      const done = yield* captains.crewReport({
        threadId: crewThread(first.order),
        report: { status: "done", summary: "Survey written." },
      });
      assert.equal(done.state, "done");
      assert.equal(yield* orderState(captain, first.order.id), "done");
      assert.equal(yield* orderState(captain, second.order.id), "running");
      assert.equal(harness.launches.length, 2);
    }),
  ),
);

it.effect("holds a change order's files until its review accepts it, then admits the queue", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const first = yield* create(captain, order({ title: "readme", touches: ["README.md"] }));
      const second = yield* create(captain, order({ title: "readme-two", touches: ["README.md"] }));
      const reported = yield* captains.crewReport({
        threadId: crewThread(first.order),
        report: { status: "done", summary: "README juiced up." },
      });
      assert.equal(reported.state, "reviewing");
      assert.equal(yield* orderState(captain, second.order.id), "queued");
      yield* captains.drain;
      const reviewing = (yield* captains.listOrders(captain)).find((o) => o.id === first.order.id);
      const reviewerThread = reviewing?.review?.threadId;
      assert.isDefined(reviewerThread);
      yield* captains.submitReview({
        threadId: reviewerThread!,
        review: { verdict: "approve", findings: [] },
      });
      assert.equal(yield* orderState(captain, first.order.id), "accepted");
      assert.equal(yield* orderState(captain, second.order.id), "running");
      assert.equal(harness.launches.length, 3);
    }),
  ),
);

it.effect("keeps a report's write-up and refuses reports from threads that are not crew", () =>
  withHarness({}, () =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(
        captain,
        order({ title: "benchmarks", kind: "report", touches: [] }),
      );
      yield* captains.crewReport({
        threadId: crewThread(created.order),
        report: { status: "done", summary: "10 rows.", reportMd: "# Results" },
      });
      const read = yield* captains.readOrder({ captain, orderId: created.order.id });
      assert.equal(read.order.reportMd, "# Results");
      assert.equal(read.order.lastReport?.status, "done");
      const refused = yield* captains
        .crewReport({
          threadId: ThreadId.make("thread:stranger"),
          report: { status: "done", summary: "x" },
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "not_crew");
    }),
  ),
);

it.effect("holds orders behind their dependencies and rejects unknown ones", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const base = yield* create(
        captain,
        order({ title: "api", kind: "report", touches: ["api/**"] }),
      );
      const dependent = yield* create(
        captain,
        order({ title: "client", touches: ["client/**"], dependsOn: [base.order.id] }),
      );
      assert.equal(dependent.order.state, "queued");
      const unknown = yield* create(
        captain,
        order({ title: "bad", dependsOn: ["order:nope" as CaptainOrderId] }),
      ).pipe(Effect.flip);
      assert.equal(unknown.reason, "invalid_order");
      yield* captains.crewReport({
        threadId: crewThread(base.order),
        report: { status: "done", summary: "API shipped." },
      });
      assert.equal(yield* orderState(captain, dependent.order.id), "running");
      const text = harness.launches.at(-1)?.initialMessage?.text ?? "";
      assert.include(text, "Finished orders you build on:");
      assert.include(text, "- api: API shipped.");
    }),
  ),
);

it.effect("runs at most crewCap orders at once", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captain = yield* makeCaptain;
      const created = [];
      for (const title of ["a", "b", "c", "d"]) {
        created.push(yield* create(captain, order({ title })));
      }
      assert.deepEqual(
        created.map((entry) => entry.order.state),
        ["running", "running", "running", "queued"],
      );
      assert.equal(harness.launches.length, 3);
    }),
  ),
);

it.effect("refuses crew above the captain's mode, and clamps a mode lowered after ordering", () =>
  withHarness({ captainShell: { runtimeMode: "auto" } }, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const refused = yield* captains
        .createOrder({
          captain,
          order: order({ title: "ambitious" }),
          runtimeModeCeiling: "auto",
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "invalid_order");
      assert.include(refused.message, "above this captain's auto");
      assert.equal(harness.launches.length, 0);
      const allowed = yield* captains.createOrder({
        captain,
        order: order({ title: "careful", placement: { runtimeMode: "auto" } }),
        runtimeModeCeiling: "auto",
      });
      assert.equal(allowed.order.state, "running");
      assert.equal(harness.launches[0]?.runtimeMode, "auto");
      harness.shells.set(
        captainThreadId,
        shell(captainThreadId, { runtimeMode: "approval-required" }),
      );
      yield* captains.createOrder({
        captain,
        order: order({ title: "after", placement: { runtimeMode: "auto" } }),
        runtimeModeCeiling: "auto",
      });
      assert.equal(harness.launches[1]?.runtimeMode, "approval-required");
    }),
  ),
);

it.effect("drops a queued order quietly and stops a running crew, then admits the next", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const running = yield* create(captain, order({ title: "one", touches: ["x/"] }));
      const queued = yield* create(captain, order({ title: "two", touches: ["x/"] }));
      const waiting = yield* create(captain, order({ title: "three", touches: ["x/"] }));
      yield* captains.dropOrder({ captain, orderId: queued.order.id, reason: "not needed" });
      assert.equal(harness.interrupts.length, 0);
      assert.equal(yield* orderState(captain, queued.order.id), "dropped");
      yield* captains.dropOrder({ captain, orderId: running.order.id, reason: "wrong approach" });
      assert.equal(harness.interrupts.length, 1);
      assert.equal(harness.interrupts[0]?.threadId, crewThread(running.order));
      assert.isTrue(
        harness.commands.some(
          (command) =>
            command.type === "queue.hold" && command.threadId === crewThread(running.order),
        ),
      );
      assert.equal(yield* captains.roleOf(crewThread(running.order)), undefined);
      assert.equal(yield* orderState(captain, waiting.order.id), "running");
      const done = yield* captains
        .dropOrder({ captain, orderId: waiting.order.id, reason: "x" })
        .pipe(
          Effect.andThen(
            captains.dropOrder({ captain, orderId: running.order.id, reason: "again" }),
          ),
        );
      assert.equal(done.state, "dropped");
    }),
  ),
);

it.effect("messages only running crew, as the captain", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const running = yield* create(captain, order({ title: "one", touches: ["x/"] }));
      const queued = yield* create(captain, order({ title: "two", touches: ["x/"] }));
      const sent = yield* captains.sendToOrder({
        captain,
        orderId: running.order.id,
        text: "Also update the changelog.",
        mode: "steer",
      });
      assert.equal(sent.delivery, "queued");
      assert.equal(harness.sends[0]?.senderThreadId, captainThreadId);
      assert.equal(harness.sends[0]?.threadId, crewThread(running.order));
      assert.equal(harness.sends[0]?.mode, "steer");
      const refused = yield* captains
        .sendToOrder({ captain, orderId: queued.order.id, text: "hi", mode: "queue" })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "crew_not_running");
    }),
  ),
);

it.effect("reads an order with its crew's latest messages", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "one" }));
      harness.messages.set(
        crewThread(created.order),
        Array.from({ length: 8 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `message ${index}`,
          createdAt: `2026-11-05T10:00:0${index}.000Z`,
        })),
      );
      const read = yield* captains.readOrder({ captain, orderId: created.order.id });
      assert.deepEqual(
        read.recentMessages.map((message) => message.text),
        ["message 3", "message 4", "message 5", "message 6", "message 7"],
      );
    }),
  ),
);

it.effect("drops an order whose crew cannot start and says why", () =>
  withHarness({ launchFails: true }, () =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const subscription = yield* captains.subscribeSignals;
      const created = yield* create(captain, order({ title: "doomed" }));
      assert.equal(created.order.state, "dropped");
      const signal = yield* PubSub.take(subscription);
      assert.equal(signal.kind, "launch_failed");
      assert.equal(signal.order?.id, created.order.id);
    }),
  ),
);

it.effect("releases a captain: queue held, tools gone, queued orders never start", () =>
  withHarness({}, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const running = yield* create(captain, order({ title: "one", touches: ["x/"] }));
      const queued = yield* create(captain, order({ title: "two", touches: ["x/"] }));
      const released = yield* captains.release(captain.id);
      assert.equal(released.status, "released");
      assert.isTrue(
        harness.commands.some(
          (command) => command.type === "queue.hold" && command.threadId === captainThreadId,
        ),
      );
      assert.equal(yield* captains.roleOf(captainThreadId), undefined);
      assert.deepEqual(yield* captains.roleOf(crewThread(running.order)), {
        role: "crew",
        captainId: captain.id,
        orderId: running.order.id,
      });
      assert.equal(
        (yield* captains.requireCaptain(captainThreadId).pipe(Effect.flip)).reason,
        "not_a_captain",
      );
      const refused = yield* captains
        .createOrder({
          captain: released,
          order: order({ title: "late" }),
          runtimeModeCeiling: "full-access",
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "captain_not_active");
      yield* captains.crewReport({
        threadId: crewThread(running.order),
        report: { status: "done", summary: "done" },
      });
      assert.equal(yield* orderState(captain, queued.order.id), "queued");
      const again = yield* captains.create({ threadId: captainThreadId });
      assert.equal(again.id, captain.id);
      assert.equal(again.status, "active");
    }),
  ),
);

it.effect("loads roles from the tables at startup and creates no scheduled tasks", () =>
  withHarness({}, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "one" }));
      const rows = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM scheduled_tasks`;
      assert.equal(rows[0]?.count, 0);
      const fresh = yield* CaptainService.CaptainService.pipe(Effect.provide(CaptainService.layer));
      assert.deepEqual(yield* fresh.roleOf(captainThreadId), {
        role: "captain",
        captainId: captain.id,
      });
      assert.deepEqual(yield* fresh.roleOf(crewThread(created.order)), {
        role: "crew",
        captainId: captain.id,
        orderId: created.order.id,
      });
      assert.isTrue(Option.isSome(yield* fresh.crewOf(crewThread(created.order))));
    }),
  ),
);
