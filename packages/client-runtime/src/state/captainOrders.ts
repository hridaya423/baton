import { WS_METHODS } from "@t3tools/contracts";
import type { CaptainOrderState } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export type BoardOrderState = CaptainOrderState;

export function createCaptainOrderAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Full orders of one captain: the brief, report, verify log tail and review findings. */
    orders: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:captains:orders",
      tag: WS_METHODS.captainsOrdersList,
    }),
    landOrder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:land-order",
      tag: WS_METHODS.captainsOrdersLand,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.orderId}`,
      },
    }),
    retryOrder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:retry-order",
      tag: WS_METHODS.captainsOrdersRetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.orderId}`,
      },
    }),
    dropOrder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:drop-order",
      tag: WS_METHODS.captainsOrdersDrop,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.orderId}`,
      },
    }),
    updateCaptain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:update",
      tag: WS_METHODS.captainsUpdate,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.captainId}`,
      },
    }),
  };
}
