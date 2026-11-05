import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EMPTY_CAPTAIN_BOARD, reduceCaptainBoard } from "./captainBoard.ts";
import { createCaptainOrderAtoms } from "./captainOrders.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCaptainEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    ...createCaptainOrderAtoms(runtime),
    /** The environment's captains, their orders and open needs-you items, folded from the stream. */
    board: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:captains:board",
      tag: WS_METHODS.captainsBoardSubscribe,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_CAPTAIN_BOARD, reduceCaptainBoard)),
    }),
    makeCaptain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:create",
      tag: WS_METHODS.captainsCreate,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    releaseCaptain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:release",
      tag: WS_METHODS.captainsRelease,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.captainId}`,
      },
    }),
    resolveEscalation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:resolve-escalation",
      tag: WS_METHODS.captainsEscalationsResolve,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.escalationId}`,
      },
    }),
  };
}
