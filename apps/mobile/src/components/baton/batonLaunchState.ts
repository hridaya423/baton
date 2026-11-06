import { useSyncExternalStore } from "react";

export type LaunchPhase = "pending" | "playing" | "done";

export interface LaunchTarget {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** When the launch mark starts moving into the header, after it is built and glinted. */
export const LAUNCH_HANDOFF_AT_MS = 950;

// Module state lives as long as the JS runtime, so a warm resume finds the launch already done.
let phase: LaunchPhase = "pending";
let startedAt = 0;
let target: LaunchTarget | null = null;
const listeners = new Set<() => void>();

function setPhase(next: LaunchPhase) {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLaunchPhase(): LaunchPhase {
  return useSyncExternalStore(subscribe, () => phase);
}

export function beginLaunch(nowMs: number) {
  if (phase !== "pending") return;
  startedAt = nowMs;
  setPhase("playing");
}

export function finishLaunch() {
  setPhase("done");
}

export function setLaunchTarget(next: LaunchTarget) {
  target = next;
}

export function launchTarget(): LaunchTarget | null {
  return target;
}

/** How long a row mounting now should wait so its rise shows after the launch mark hands off. */
export function launchRevealOffsetMs(nowMs = Date.now()): number {
  return phase === "playing" ? Math.max(0, LAUNCH_HANDOFF_AT_MS - (nowMs - startedAt)) : 0;
}
