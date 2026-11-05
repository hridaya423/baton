import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const mediaSpendToday = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:media:spend",
  tag: WS_METHODS.mediaSpend,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
