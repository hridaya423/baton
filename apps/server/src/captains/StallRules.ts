import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

/** How many whole stall windows a crew has been silent for, at most 2: one wakes, two escalates. */
export const stallLevelFor = (idleMs: number, stallMs: number): 0 | 1 | 2 =>
  idleMs >= 2 * stallMs ? 2 : idleMs >= stallMs ? 1 : 0;

/** A crew waiting on its own background command, a watched PR or an open request is not stalled. */
export const holdsStall = (
  shell: Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks" | "pendingRuntimeRequest"> & {
    readonly pullRequests?: ReadonlyArray<{ readonly watch?: unknown }> | undefined;
  },
): boolean =>
  (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
  shell.pendingRuntimeRequest !== null ||
  (shell.pullRequests ?? []).some((link) => link.watch !== undefined && link.watch !== null);
