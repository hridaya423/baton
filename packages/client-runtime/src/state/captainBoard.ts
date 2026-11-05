import type {
  Captain,
  CaptainBoardEvent,
  CaptainBoardOrder,
  CaptainEscalation,
  CaptainEscalationId,
  CaptainId,
  CaptainOrderId,
  ThreadId,
} from "@t3tools/contracts";

import type { BoardOrderState } from "./captainOrders.ts";

export type { BoardOrderState };

export interface CaptainBoardState {
  readonly loaded: boolean;
  readonly captains: ReadonlyMap<CaptainId, Captain>;
  readonly orders: ReadonlyMap<CaptainOrderId, CaptainBoardOrder>;
  readonly escalations: ReadonlyMap<CaptainEscalationId, CaptainEscalation>;
}

export const EMPTY_CAPTAIN_BOARD: CaptainBoardState = {
  loaded: false,
  captains: new Map(),
  orders: new Map(),
  escalations: new Map(),
};

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V | null): ReadonlyMap<K, V> => {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
};

export function reduceCaptainBoard(
  state: CaptainBoardState,
  event: CaptainBoardEvent,
): CaptainBoardState {
  switch (event.type) {
    case "snapshot":
      return {
        loaded: true,
        captains: new Map(event.captains.map((captain) => [captain.id, captain])),
        orders: new Map(event.orders.map((order) => [order.id, order])),
        escalations: new Map(event.escalations.map((item) => [item.id, item])),
      };
    case "captain":
      return { ...state, captains: withEntry(state.captains, event.captain.id, event.captain) };
    case "order":
      return { ...state, orders: withEntry(state.orders, event.order.id, event.order) };
    case "escalation":
      return {
        ...state,
        escalations: withEntry(
          state.escalations,
          event.escalation.id,
          event.escalation.status === "open" ? event.escalation : null,
        ),
      };
  }
}

export type CaptainBoardColumn = "queued" | "running" | "checking" | "needs-you" | "done";

export const CAPTAIN_BOARD_COLUMNS: ReadonlyArray<CaptainBoardColumn> = [
  "queued",
  "running",
  "checking",
  "needs-you",
  "done",
];

/** `null` for a dropped order, which the board keeps behind a toggle. */
export function captainBoardColumn(
  state: BoardOrderState,
  needsYou: boolean,
): CaptainBoardColumn | null {
  if (state === "dropped") return null;
  if (needsYou) return "needs-you";
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "verifying":
    case "verify_failed":
    case "reviewing":
      return "checking";
    case "accepted":
    case "landing":
    case "landed":
    case "done":
    case "land_failed":
      return "done";
  }
}

export interface CaptainBoardColumns {
  readonly columns: Readonly<Record<CaptainBoardColumn, ReadonlyArray<CaptainBoardOrder>>>;
  readonly dropped: ReadonlyArray<CaptainBoardOrder>;
  /** Open items no order owns, so no card carries them. */
  readonly looseEscalations: ReadonlyArray<CaptainEscalation>;
}

export const openEscalationsByOrder = (
  escalations: Iterable<CaptainEscalation>,
): ReadonlyMap<CaptainOrderId, ReadonlyArray<CaptainEscalation>> => {
  const byOrder = new Map<CaptainOrderId, Array<CaptainEscalation>>();
  for (const item of escalations) {
    if (item.status !== "open" || item.orderId === null) continue;
    byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), item]);
  }
  return byOrder;
};

export function captainBoardColumns(
  state: CaptainBoardState,
  captainId: CaptainId,
): CaptainBoardColumns {
  const open = [...state.escalations.values()]
    .filter((item) => item.captainId === captainId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byOrder = openEscalationsByOrder(open);
  const columns: Record<CaptainBoardColumn, Array<CaptainBoardOrder>> = {
    queued: [],
    running: [],
    checking: [],
    "needs-you": [],
    done: [],
  };
  const dropped: Array<CaptainBoardOrder> = [];
  const orders = [...state.orders.values()]
    .filter((order) => order.captainId === captainId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const order of orders) {
    const column = captainBoardColumn(order.state, byOrder.has(order.id));
    if (column === null) dropped.push(order);
    else columns[column].push(order);
  }
  return {
    columns,
    dropped,
    looseEscalations: open.filter(
      (item) => item.orderId === null || !state.orders.has(item.orderId),
    ),
  };
}

/** The order a phone reads the board in: what waits on the user first, then what is in flight. */
const CAPTAIN_BOARD_SECTION_ORDER: ReadonlyArray<CaptainBoardColumn> = [
  "needs-you",
  "running",
  "checking",
  "queued",
  "done",
];

export interface CaptainBoardSection {
  readonly column: CaptainBoardColumn;
  readonly orders: ReadonlyArray<CaptainBoardOrder>;
  /** Only the needs-you section carries the open items no order owns. */
  readonly looseEscalations: ReadonlyArray<CaptainEscalation>;
}

/** The board as a list: its non-empty sections, in reading order. */
export function captainBoardSections(
  board: CaptainBoardColumns,
): ReadonlyArray<CaptainBoardSection> {
  return CAPTAIN_BOARD_SECTION_ORDER.flatMap((column) => {
    const orders = board.columns[column];
    const looseEscalations = column === "needs-you" ? board.looseEscalations : [];
    return orders.length + looseEscalations.length === 0
      ? []
      : [{ column, orders, looseEscalations }];
  });
}

export type CaptainCrewDot = "running" | "needs-you" | "done";

export interface CaptainCrewEntry {
  readonly threadId: ThreadId;
  readonly order: CaptainBoardOrder;
  readonly dot: CaptainCrewDot;
}

export interface CaptainSidebarIndex {
  readonly captainByThreadId: ReadonlyMap<ThreadId, Captain>;
  readonly crewByCaptainThreadId: ReadonlyMap<ThreadId, ReadonlyArray<CaptainCrewEntry>>;
  /** Crew threads show nested under their captain, not in the list. */
  readonly nestedThreadIds: ReadonlySet<ThreadId>;
  /** Reviewer threads show nowhere in the list. */
  readonly hiddenThreadIds: ReadonlySet<ThreadId>;
  readonly needsYouByCaptainThreadId: ReadonlyMap<ThreadId, number>;
}

function crewDot(state: BoardOrderState, needsYou: boolean): CaptainCrewDot {
  if (needsYou) return "needs-you";
  switch (state) {
    case "queued":
    case "running":
    case "verifying":
    case "verify_failed":
    case "reviewing":
      return "running";
    case "accepted":
    case "landing":
    case "landed":
    case "done":
    case "land_failed":
    case "dropped":
      return "done";
  }
}

export function captainSidebarIndex(state: CaptainBoardState): CaptainSidebarIndex {
  const live = new Map<CaptainId, Captain>();
  for (const captain of state.captains.values()) {
    if (captain.status !== "released") live.set(captain.id, captain);
  }
  const byOrder = openEscalationsByOrder(state.escalations.values());
  const crew = new Map<ThreadId, Array<CaptainCrewEntry>>();
  const nested = new Set<ThreadId>();
  const hidden = new Set<ThreadId>();
  for (const order of state.orders.values()) {
    for (const threadId of order.review?.threadIds ?? []) hidden.add(threadId);
    const captain = live.get(order.captainId);
    if (captain === undefined || order.threadId === null) continue;
    nested.add(order.threadId);
    crew.set(captain.threadId, [
      ...(crew.get(captain.threadId) ?? []),
      {
        threadId: order.threadId,
        order,
        dot: crewDot(order.state, byOrder.has(order.id)),
      },
    ]);
  }
  const needsYou = new Map<ThreadId, number>();
  for (const item of state.escalations.values()) {
    const captain = live.get(item.captainId);
    if (item.status !== "open" || captain === undefined) continue;
    needsYou.set(captain.threadId, (needsYou.get(captain.threadId) ?? 0) + 1);
  }
  return {
    captainByThreadId: new Map([...live.values()].map((captain) => [captain.threadId, captain])),
    crewByCaptainThreadId: new Map(
      [...crew].map(
        ([threadId, entries]) =>
          [
            threadId,
            [...entries].sort((a, b) => a.order.createdAt.localeCompare(b.order.createdAt)),
          ] as const,
      ),
    ),
    nestedThreadIds: nested,
    hiddenThreadIds: hidden,
    needsYouByCaptainThreadId: needsYou,
  };
}

/** Everything across captains waiting on the user, oldest first. */
export const openCaptainEscalations = (
  state: CaptainBoardState,
): ReadonlyArray<CaptainEscalation> =>
  [...state.escalations.values()]
    .filter(
      (item) => item.status === "open" && state.captains.get(item.captainId)?.status !== "released",
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
