import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createMediaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** What a project spent on image and video calls since midnight UTC, and its daily cap. */
    spendToday: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:media:spend",
      tag: WS_METHODS.mediaSpend,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}
