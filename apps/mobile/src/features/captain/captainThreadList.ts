import type { CaptainSidebarIndex } from "@t3tools/client-runtime/state/captainBoard";
import {
  captainHiddenKeysFor,
  captainThreadKey,
} from "@t3tools/client-runtime/state/captainPresentation";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

type ListedThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedAt"> &
  Partial<Pick<EnvironmentThreadShell, "captainRole" | "groupedUnderThreadId">>;

/**
 * The threads the list shows: reviewer threads never, and crew threads only where their captain's
 * row is not there to nest them. Returns the same array when nothing is left out, so the list
 * keeps its identity on servers without captains.
 */
export function omitCaptainNestedThreads<T extends ListedThread>(
  threads: ReadonlyArray<T>,
  indexes: ReadonlyMap<EnvironmentId, CaptainSidebarIndex>,
): ReadonlyArray<T> {
  const hidden = captainHiddenKeysFor(indexes, threads);
  if (hidden.size === 0) return threads;
  const visible = threads.filter(
    (thread) => !hidden.has(captainThreadKey(thread.environmentId, thread.id)),
  );
  return visible.length === threads.length ? threads : visible;
}
