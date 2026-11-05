// M3: the RPCs below land with milestone 3. When they are in contracts, replace each stand-in with
// createEnvironmentRpcCommand on its WS_METHODS tag, drop the local types, and import the real
// CaptainOrderState. Nothing outside this file names these method strings.
import type {
  Captain,
  CaptainBoardLand,
  CaptainCharter,
  CaptainId,
  CaptainOrder,
  CaptainOrderDelivery,
  CaptainOrderId,
  CaptainOrderState,
  CaptainStatus,
} from "@t3tools/contracts";
import { type WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { type EnvironmentRpcFailure, requestGuarded } from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";

export type BoardOrderState = CaptainOrderState | "landing" | "landed" | "land_failed";

export type CaptainOrderDetail = Omit<CaptainOrder, "state"> & {
  readonly state: BoardOrderState;
  readonly land?: CaptainBoardLand | null;
};

const METHODS = {
  ordersList: "captains.orders.list",
  ordersLand: "captains.orders.land",
  ordersRetry: "captains.orders.retry",
  ordersDrop: "captains.orders.drop",
  update: "captains.update",
} as const;

type CaptainFailure = EnvironmentRpcFailure<typeof WS_METHODS.captainsRelease>;

const requestByName = requestGuarded as unknown as (
  method: string,
  input: unknown,
) => Effect.Effect<unknown, CaptainFailure, EnvironmentSupervisor.EnvironmentSupervisor>;

const call = <A>(method: string, input: unknown) =>
  requestByName(method, input).pipe(Effect.map((result) => result as A));

export function createCaptainM3Atoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const command = <Input, A>(label: string, method: string, keyOf?: (input: Input) => string) => ({
    ...createEnvironmentCommand(runtime, {
      label: `environment-data:captains:${label}`,
      execute: (input: Input) => call<A>(method, input),
      ...(keyOf === undefined
        ? {}
        : {
            concurrency: {
              mode: "singleFlight" as const,
              key: ({ environmentId, input }: { environmentId: string; input: Input }) =>
                `${environmentId}:${keyOf(input)}`,
            },
          }),
    }),
    permissionAtom: createCommandPermissions(runtime, method).permissionAtom,
  });
  return {
    /** Full orders of one captain: the brief, report, verify log tail and review findings. */
    orders: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:captains:orders",
      staleTimeMs: 2_000,
      execute: (input: { readonly captainId: CaptainId }) =>
        call<{ readonly orders: ReadonlyArray<CaptainOrderDetail> }>(METHODS.ordersList, input),
    }),
    landOrder: command<
      { readonly orderId: CaptainOrderId; readonly delivery?: CaptainOrderDelivery },
      unknown
    >("land-order", METHODS.ordersLand, (input) => input.orderId),
    retryOrder: command<{ readonly orderId: CaptainOrderId; readonly brief?: string }, unknown>(
      "retry-order",
      METHODS.ordersRetry,
      (input) => input.orderId,
    ),
    dropOrder: command<{ readonly orderId: CaptainOrderId; readonly reason?: string }, unknown>(
      "drop-order",
      METHODS.ordersDrop,
      (input) => input.orderId,
    ),
    updateCaptain: command<
      {
        readonly captainId: CaptainId;
        readonly status?: Exclude<CaptainStatus, "released">;
        readonly charter?: CaptainCharter;
      },
      { readonly captain: Captain }
    >("update", METHODS.update, (input) => input.captainId),
  };
}
