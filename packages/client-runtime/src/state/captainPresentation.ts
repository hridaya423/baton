import type {
  CaptainBoardOrder,
  CaptainEscalationKind,
  CaptainOrderDelivery,
  CaptainOrderKind,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { isListedThreadLineage } from "@t3tools/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/index.ts";
import {
  openCaptainEscalations,
  type BoardOrderState,
  type CaptainBoardColumn,
  type CaptainBoardState,
  type CaptainSidebarIndex,
} from "./captainBoard.ts";
import type { EnvironmentThreadShell } from "./shell.ts";

export const BOARD_COLUMN_LABELS: Record<CaptainBoardColumn, string> = {
  queued: "Queued",
  running: "Running",
  checking: "Checking",
  "needs-you": "Needs you",
  done: "Done",
};

export const ESCALATION_KIND_LABELS: Record<CaptainEscalationKind, string> = {
  decision: "Decision",
  approval: "Approval",
  one_way_door: "One-way door",
  retry_limit: "Retry limit",
  budget: "Budget",
  stall: "Stalled",
  conflict: "Conflict",
};

export const ORDER_KIND_LABELS: Record<CaptainOrderKind, string> = {
  change: "Change",
  report: "Report",
};

export const DELIVERY_LABELS: Record<CaptainOrderDelivery, string> = {
  none: "Stays in its worktree",
  branch: "Branch",
  pr: "Pull request",
  merge: "Merge",
};

export const LAND_DELIVERIES = ["branch", "pr", "merge"] as const;

export const ORDER_STATE_LABELS: Record<BoardOrderState, string> = {
  queued: "Queued",
  running: "Running",
  verifying: "Running the check",
  verify_failed: "Check failed",
  reviewing: "In review",
  accepted: "Accepted",
  landing: "Landing",
  landed: "Landed",
  land_failed: "Landing failed",
  done: "Done",
  dropped: "Dropped",
};

export function verifySummary(exit: number | null): {
  readonly passed: boolean;
  readonly label: string;
} {
  if (exit === 0) return { passed: true, label: "Check passed" };
  return {
    passed: false,
    label: exit === null ? "Check timed out" : `Check failed (exit ${exit})`,
  };
}

export type CaptainTone = "success" | "error" | "info";

export function reviewSummary(review: NonNullable<CaptainBoardOrder["review"]>): {
  readonly label: string;
  readonly tone: CaptainTone;
  readonly findings: string | null;
} {
  const label =
    review.verdict === "approve"
      ? "Review approved"
      : review.verdict === "reject"
        ? "Review rejected"
        : "In review";
  return {
    label,
    tone: review.verdict === "approve" ? "success" : review.verdict === "reject" ? "error" : "info",
    findings:
      review.verdict === null
        ? null
        : review.findingsCount === 1
          ? "1 finding"
          : `${review.findingsCount} findings`,
  };
}

export function canLand(state: BoardOrderState, kind: CaptainOrderKind): boolean {
  return kind === "change" && (state === "accepted" || state === "land_failed");
}

export function canRetry(state: BoardOrderState): boolean {
  return (
    state === "running" ||
    state === "verifying" ||
    state === "verify_failed" ||
    state === "reviewing" ||
    state === "land_failed"
  );
}

export function canDrop(state: BoardOrderState): boolean {
  return canRetry(state) || state === "queued";
}

export type CaptainMenuActionId =
  | "make-captain"
  | "release-captain"
  | "pause-captain"
  | "resume-captain"
  | "open-crew-board";

export type CaptainMenuState =
  | { readonly kind: "none" }
  | { readonly kind: "make" }
  | { readonly kind: "captain"; readonly status: "active" | "paused" };

type ThreadForCaptain = Pick<EnvironmentThreadShell, "id" | "lineage" | "archivedAt"> & {
  readonly delegatedFrom?: unknown;
};

export function captainMenuState(
  thread: ThreadForCaptain,
  index: CaptainSidebarIndex | undefined,
): CaptainMenuState {
  if (index === undefined) return { kind: "none" };
  const captain = index.captainByThreadId.get(thread.id);
  if (captain !== undefined) {
    return { kind: "captain", status: captain.status === "paused" ? "paused" : "active" };
  }
  const notAThread =
    !isListedThreadLineage(thread.lineage) ||
    thread.delegatedFrom != null ||
    thread.archivedAt !== null ||
    index.nestedThreadIds.has(thread.id) ||
    index.hiddenThreadIds.has(thread.id);
  return notAThread ? { kind: "none" } : { kind: "make" };
}

export const captainThreadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));

/**
 * Thread keys a thread list leaves out: reviewer threads always, and crew threads whose captain
 * row is in the list to show them nested.
 */
export function captainHiddenThreadKeys(
  indexes: ReadonlyMap<EnvironmentId, CaptainSidebarIndex>,
  listedThreadKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const [environmentId, index] of indexes) {
    for (const threadId of index.hiddenThreadIds) {
      hidden.add(captainThreadKey(environmentId, threadId));
    }
    for (const [captainThreadId, crew] of index.crewByCaptainThreadId) {
      if (!listedThreadKeys.has(captainThreadKey(environmentId, captainThreadId))) continue;
      for (const entry of crew) hidden.add(captainThreadKey(environmentId, entry.threadId));
    }
  }
  return hidden;
}

export function captainMenuItems(state: CaptainMenuState) {
  switch (state.kind) {
    case "none":
      return [];
    case "make":
      return [{ id: "make-captain" as const, label: "Make captain", icon: "anchor" }];
    case "captain":
      return [
        { id: "open-crew-board" as const, label: "Open crew board", icon: "anchor" },
        state.status === "paused"
          ? { id: "resume-captain" as const, label: "Resume captain", icon: "play" }
          : { id: "pause-captain" as const, label: "Pause captain", icon: "pause" },
        { id: "release-captain" as const, label: "Release captain", icon: "anchor" },
      ];
  }
}

/** The live captains across environments, and how many of their items wait on the user. */
export function countOpenCaptainEscalations(boards: ReadonlyMap<EnvironmentId, CaptainBoardState>) {
  let captains = 0;
  let open = 0;
  for (const board of boards.values()) {
    for (const captain of board.captains.values()) if (captain.status !== "released") captains += 1;
    open += openCaptainEscalations(board).length;
  }
  return { captains, open };
}

const NO_HIDDEN_KEYS: ReadonlySet<string> = new Set();

/** `captainHiddenThreadKeys` for the threads a list was given; archived ones have no row to nest under. */
export function captainHiddenKeysFor(
  indexes: ReadonlyMap<EnvironmentId, CaptainSidebarIndex>,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedAt">>,
): ReadonlySet<string> {
  if (indexes.size === 0) return NO_HIDDEN_KEYS;
  const listed = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt === null) listed.add(captainThreadKey(thread.environmentId, thread.id));
  }
  return captainHiddenThreadKeys(indexes, listed);
}
