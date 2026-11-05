import {
  type CaptainBoardState,
  type CaptainSidebarIndex,
  openCaptainEscalations,
} from "@t3tools/client-runtime/state/captainBoard";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, isListedThreadLineage, type ThreadId } from "@t3tools/contracts";

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
 * Thread keys the sidebar leaves out of its list: reviewer threads always, and crew threads
 * whose captain row is in the list to show them nested.
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

/** `captainHiddenThreadKeys` for the threads the sidebar was given; archived ones have no row to nest under. */
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

const NO_HIDDEN_KEYS: ReadonlySet<string> = new Set();
