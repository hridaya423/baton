import type {
  Captain,
  CaptainBoardEvent,
  CaptainBoardOrder,
  CaptainEscalation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  captainBoardColumn,
  captainBoardColumns,
  captainSidebarIndex,
  EMPTY_CAPTAIN_BOARD,
  openCaptainEscalations,
  reduceCaptainBoard,
} from "./captainBoard.ts";
import type { BoardOrderState } from "./captainsM3.ts";

const AT = "2026-11-05T10:00:00.000Z";

const captain = (id: string, fields: Partial<Captain> = {}) =>
  ({
    id,
    projectId: "project:1",
    threadId: `thread:${id}`,
    name: id,
    status: "active",
    charter: {},
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  }) as unknown as Captain;

const order = (
  id: string,
  fields: Partial<Omit<CaptainBoardOrder, "state" | "captainId">> & {
    state?: BoardOrderState;
    captainId?: string;
  } = {},
) =>
  ({
    id,
    captainId: "captain:a",
    threadId: `crew:${id}`,
    kind: "change",
    title: id,
    delivery: "branch",
    state: "running",
    retries: 0,
    branch: null,
    dependsOn: [],
    placement: {},
    lastReport: null,
    verify: null,
    review: null,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  }) as unknown as CaptainBoardOrder;

const escalation = (id: string, fields: Partial<CaptainEscalation> = {}) =>
  ({
    id,
    captainId: "captain:a",
    orderId: null,
    kind: "decision",
    summary: id,
    detail: "",
    options: [],
    status: "open",
    resolution: null,
    requestId: null,
    createdAt: AT,
    resolvedAt: null,
    ...fields,
  }) as unknown as CaptainEscalation;

const snapshot = (
  captains: ReadonlyArray<Captain>,
  orders: ReadonlyArray<CaptainBoardOrder>,
  escalations: ReadonlyArray<CaptainEscalation> = [],
): CaptainBoardEvent => ({ type: "snapshot", captains, orders, escalations });

describe("captainBoardColumn", () => {
  const cases: ReadonlyArray<readonly [BoardOrderState, boolean, string | null]> = [
    ["queued", false, "queued"],
    ["running", false, "running"],
    ["verifying", false, "checking"],
    ["verify_failed", false, "checking"],
    ["reviewing", false, "checking"],
    ["accepted", false, "done"],
    ["landing", false, "done"],
    ["landed", false, "done"],
    ["done", false, "done"],
    ["land_failed", false, "done"],
    ["dropped", false, null],
    ["running", true, "needs-you"],
    ["reviewing", true, "needs-you"],
    ["dropped", true, null],
  ];
  it.each(cases)("%s, needs you %s, is in %s", (state, needsYou, column) => {
    expect(captainBoardColumn(state, needsYou)).toBe(column);
  });
});

describe("captainBoardColumns", () => {
  it("sorts a captain's orders into columns, keeps dropped ones aside and strays loose", () => {
    const state = reduceCaptainBoard(
      EMPTY_CAPTAIN_BOARD,
      snapshot(
        [captain("captain:a"), captain("captain:b")],
        [
          order("order:1", { state: "queued", threadId: null }),
          order("order:2"),
          order("order:3", { state: "reviewing" }),
          order("order:4", { state: "landed" }),
          order("order:5", { state: "dropped" }),
          order("order:6"),
          order("order:other", { captainId: "captain:b", state: "queued" }),
        ],
        [
          escalation("esc:1", { orderId: "order:6" as never }),
          escalation("esc:2"),
          escalation("esc:other", { captainId: "captain:b" as never }),
        ],
      ),
    );
    const board = captainBoardColumns(state, "captain:a" as never);
    const ids = (orders: ReadonlyArray<CaptainBoardOrder>) => orders.map((item) => item.id);
    expect(ids(board.columns.queued)).toEqual(["order:1"]);
    expect(ids(board.columns.running)).toEqual(["order:2"]);
    expect(ids(board.columns.checking)).toEqual(["order:3"]);
    expect(ids(board.columns["needs-you"])).toEqual(["order:6"]);
    expect(ids(board.columns.done)).toEqual(["order:4"]);
    expect(ids(board.dropped)).toEqual(["order:5"]);
    expect(board.looseEscalations.map((item) => item.id)).toEqual(["esc:2"]);
  });
});

describe("reduceCaptainBoard", () => {
  it("replaces rows by id and drops an item once it is resolved", () => {
    let state = reduceCaptainBoard(
      EMPTY_CAPTAIN_BOARD,
      snapshot([captain("captain:a")], [order("order:1")], [escalation("esc:1")]),
    );
    expect(state.loaded).toBe(true);
    state = reduceCaptainBoard(state, {
      type: "order",
      order: order("order:1", { state: "verifying" }),
    });
    expect(state.orders.get("order:1" as never)?.state).toBe("verifying");
    state = reduceCaptainBoard(state, {
      type: "escalation",
      escalation: escalation("esc:1", { status: "resolved", resolution: "yes" }),
    });
    expect(state.escalations.size).toBe(0);
    state = reduceCaptainBoard(state, {
      type: "captain",
      captain: captain("captain:a", { status: "paused" }),
    });
    expect(state.captains.get("captain:a" as never)?.status).toBe("paused");
  });
});

describe("captainSidebarIndex", () => {
  const state = reduceCaptainBoard(
    EMPTY_CAPTAIN_BOARD,
    snapshot(
      [captain("captain:a"), captain("captain:old", { status: "released" })],
      [
        order("order:1", {
          state: "reviewing",
          review: {
            round: 2,
            threadIds: ["captain-review:order:1:1", "captain-review:order:1:2"],
          } as never,
        }),
        order("order:2", { state: "landed" }),
        order("order:3", { captainId: "captain:old" as never }),
      ],
      [escalation("esc:1", { orderId: "order:2" as never }), escalation("esc:2")],
    ),
  );
  const index = captainSidebarIndex(state);

  it("nests crew under their live captain and gives each a dot", () => {
    expect(index.captainByThreadId.has("thread:captain:a" as never)).toBe(true);
    expect(index.captainByThreadId.has("thread:captain:old" as never)).toBe(false);
    expect(
      index.crewByCaptainThreadId
        .get("thread:captain:a" as never)
        ?.map((entry) => [entry.threadId, entry.dot]),
    ).toEqual([
      ["crew:order:1", "running"],
      ["crew:order:2", "needs-you"],
    ]);
    expect(index.nestedThreadIds.has("crew:order:3" as never)).toBe(false);
  });

  it("hides every review round's thread, even a released captain's", () => {
    expect([...index.hiddenThreadIds]).toEqual([
      "captain-review:order:1:1",
      "captain-review:order:1:2",
    ]);
  });

  it("counts open items on the captain's thread", () => {
    expect(index.needsYouByCaptainThreadId.get("thread:captain:a" as never)).toBe(2);
    expect(openCaptainEscalations(state).map((item) => item.id)).toEqual(["esc:1", "esc:2"]);
  });
});
