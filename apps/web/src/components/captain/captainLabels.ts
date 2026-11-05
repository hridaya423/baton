import type {
  BoardOrderState,
  CaptainBoardColumn,
} from "@t3tools/client-runtime/state/captainBoard";
import type {
  CaptainEscalationKind,
  CaptainOrderDelivery,
  CaptainOrderKind,
} from "@t3tools/contracts";

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

/** The order's state including those milestone 3 adds, which the wire schema does not name yet. */
export const boardOrderState = (order: { readonly state: BoardOrderState }): BoardOrderState =>
  order.state;

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
