import { assert, it } from "@effect/vitest";
import {
  type CaptainBoardEvent,
  type CaptainOrder,
  CaptainOrderId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { toBoardOrder } from "./CaptainBoard.ts";
import * as CaptainService from "./CaptainService.ts";
import { captainThreadId, makeHarness, shell } from "./Captain.testkit.ts";

const watchBoard = (
  input: Parameters<CaptainService.CaptainService["Service"]["subscribeBoard"]>[0],
) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    const events = yield* Queue.unbounded<CaptainBoardEvent>();
    yield* captains.subscribeBoard(input).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    return events;
  });

it.effect("sends a snapshot, then the changed order and the escalation it opens", () => {
  const harness = makeHarness();
  return Effect.scoped(
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.create({ threadId: captainThreadId });
      const { order: created } = yield* captains.createOrder({
        captain,
        order: { title: "survey", brief: "A long brief.", kind: "report", touches: [] },
        runtimeModeCeiling: "full-access",
      });
      const events = yield* watchBoard({});

      const snapshot = yield* Queue.take(events);
      assert.equal(snapshot.type, "snapshot");
      assert.isTrue(snapshot.type === "snapshot" && snapshot.captains[0]?.id === captain.id);
      assert.deepEqual(
        snapshot.type === "snapshot" ? snapshot.orders.map((order) => [order.id, order.state]) : [],
        [[created.id, "running"]],
      );
      assert.notInclude(JSON.stringify(snapshot), "A long brief.");

      yield* captains.crewReport({
        threadId: created.threadId as ThreadId,
        report: { status: "done", summary: "Survey written.", reportMd: "# Findings" },
      });
      const changed = yield* Queue.take(events);
      assert.isTrue(
        changed.type === "order" &&
          changed.order.id === created.id &&
          changed.order.state === "done" &&
          changed.order.lastReport?.summary === "Survey written.",
      );
      assert.notInclude(JSON.stringify(changed), "# Findings");

      yield* captains.escalate({
        captain,
        orderId: created.id,
        kind: "decision",
        summary: "Ship it?",
        detail: undefined,
        options: ["yes", "no"],
      });
      const opened = yield* Queue.take(events);
      assert.isTrue(
        opened.type === "escalation" &&
          opened.escalation.status === "open" &&
          opened.escalation.options.join() === "yes,no",
      );
    }).pipe(Effect.provide(harness.layer)),
  );
});

it.effect("sends one captain's board when asked for it", () => {
  const harness = makeHarness();
  const otherThread = ThreadId.make("thread:other-captain");
  harness.shells.set(otherThread, shell(otherThread));
  return Effect.scoped(
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const first = yield* captains.create({ threadId: captainThreadId });
      const second = yield* captains.create({ threadId: otherThread });
      const events = yield* watchBoard({ captainId: second.id });

      const snapshot = yield* Queue.take(events);
      assert.deepEqual(
        snapshot.type === "snapshot" ? snapshot.captains.map((captain) => captain.id) : [],
        [second.id],
      );
      yield* captains.release(first.id);
      yield* captains.release(second.id);
      const released = yield* Queue.take(events);
      assert.isTrue(
        released.type === "captain" &&
          released.captain.id === second.id &&
          released.captain.status === "released",
      );
      assert.equal(yield* Queue.size(events), 0);
    }).pipe(Effect.provide(harness.layer)),
  );
});

it("names every round's reviewer thread so clients can hide them", () => {
  const order = {
    id: CaptainOrderId.make("order:1"),
    captainId: "captain:1",
    threadId: null,
    kind: "change",
    title: "readme",
    brief: "Do readme.",
    doneCheck: null,
    touches: [],
    dependsOn: [],
    placement: {},
    delivery: "branch",
    state: "reviewing",
    retries: 0,
    branch: null,
    baseRef: null,
    reportMd: null,
    lastReport: null,
    verify: null,
    review: {
      round: 2,
      threadId: ThreadId.make("captain-review:order:1:2"),
      model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" },
      sameProvider: true,
      verdict: null,
      findings: [{ severity: "high", file: "README.md", scenario: "Breaks the link." }],
      previousFindings: [],
      reprompted: false,
      startedAt: "2026-11-05T10:00:00.000Z",
      finishedAt: null,
    },
    pendingFollowUp: null,
    stallLevel: 0,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    lastActivityAt: "2026-11-05T10:00:00.000Z",
  } as unknown as CaptainOrder;
  const board = toBoardOrder(order);
  assert.deepEqual(board.review?.threadIds, [
    ThreadId.make("captain-review:order:1:1"),
    ThreadId.make("captain-review:order:1:2"),
  ]);
  assert.equal(board.review?.findingsCount, 1);
  assert.equal(board.review?.sameProvider, true);
});
