import {
  type CaptainError,
  type CaptainMcpOrderSummary,
  type CaptainOrder,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CaptainService from "../../../captains/CaptainService.ts";
import { SATISFIES_DEPENDENCY } from "../../../captains/OrderPlanner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { CaptainToolkit } from "./tools.ts";

const failure = (error: CaptainError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not_a_captain" ||
      error.reason === "not_crew" ||
      error.reason === "not_reviewer" ||
      error.reason === "captain_not_active"
        ? "capability_denied"
        : error.reason === "order_not_found"
          ? "task_not_found"
          : error.reason === "invalid_order" ||
              error.reason === "crew_not_running" ||
              error.reason === "invalid_state" ||
              error.reason === "worktree"
            ? "invalid_request"
            : "orchestration_error",
    message: error.message,
  });

const toFailure = (error: CaptainError | OrchestratorMcpFailure) =>
  error._tag === "CaptainError" ? failure(error) : error;

const hostedFailure = (error: CaptainError) =>
  error.reason === "thread_not_found"
    ? new OrchestratorMcpFailure({ code: "thread_not_found", message: error.message })
    : failure(error);

const callerThread = Effect.fn("mcp.captainCaller")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
  return { scope, threadId: thread.threadId };
});

/** The model may name this environment from `t3_environment_links`; that is not a remote placement. */
const withoutLocalEnvironment = <
  Input extends {
    readonly placement?: { readonly environmentId?: string | undefined } | undefined;
  },
>(
  scope: McpInvocationContext.McpInvocationScope,
  input: Input,
): Input => {
  if (input.placement?.environmentId !== scope.environmentId) return input;
  const { environmentId: _local, ...placement } = input.placement;
  return { ...input, placement };
};

const linkField = (scope: McpInvocationContext.McpInvocationScope, order: CaptainOrder) =>
  order.threadId === null
    ? {}
    : {
        link: McpInvocationContext.threadLinkFor(
          order.environmentId === null ? scope : { ...scope, environmentId: order.environmentId },
          order.threadId,
        ),
      };

const summarize = (
  scope: McpInvocationContext.McpInvocationScope,
  order: CaptainOrder,
  orders: ReadonlyArray<CaptainOrder>,
): CaptainMcpOrderSummary => ({
  orderId: order.id,
  title: order.title,
  kind: order.kind,
  state: order.state,
  delivery: order.delivery,
  branch: order.branch,
  waitingOn:
    order.state === "queued"
      ? order.dependsOn.filter((id) => {
          const state = orders.find((o) => o.id === id)?.state;
          return state === undefined || !SATISFIES_DEPENDENCY.has(state);
        })
      : [],
  lastReport: order.lastReport,
  verify: order.verify,
  review: order.review,
  land: order.land,
  threadId: order.threadId,
  ...linkField(scope, order),
});

export const layer = McpToolAccess.toLayer(CaptainToolkit, {
  order_create: McpToolAccess.startsThreads(
    (input) => ({ runtimeMode: input.placement?.runtimeMode }),
    (input) =>
      Effect.gen(function* () {
        const { scope, threadId } = yield* callerThread("order_create");
        const { limits } = yield* readCaller();
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* captains.requireCaptain(threadId, { active: true });
        const { order, position } = yield* captains.createOrder({
          captain,
          order: withoutLocalEnvironment(scope, input),
          runtimeModeCeiling: limits.runtimeMode,
        });
        return {
          orderId: order.id,
          position,
          state: order.state,
          ...linkField(scope, order),
        };
      }).pipe(Effect.mapError(toFailure)),
    { refused: "order crew in this environment" },
  ),
  order_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { scope, threadId } = yield* callerThread("order_list");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId);
      const orders = yield* captains.listOrders(captain);
      const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
      const count = (state: CaptainOrder["state"]) =>
        orders.filter((order) => order.state === state).length;
      return {
        captain: {
          name: captain.name,
          status: captain.status,
          crewCap: captain.charter.crewCap,
        },
        counts: {
          queued: count("queued"),
          running: count("running"),
          verifying: count("verifying"),
          verify_failed: count("verify_failed"),
          reviewing: count("reviewing"),
          accepted: count("accepted"),
          landing: count("landing"),
          landed: count("landed"),
          land_failed: count("land_failed"),
          done: count("done"),
          dropped: count("dropped"),
        },
        needsYou: open.length,
        orders: orders.map((order) => summarize(scope, order, orders)),
      };
    }).pipe(Effect.mapError(toFailure)),
  ),
  order_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threadId } = yield* callerThread("order_read");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId);
      const { order, recentMessages } = yield* captains.readOrder({
        captain,
        orderId: input.orderId,
      });
      return {
        order,
        recentMessages,
        ...linkField(scope, order),
      };
    }).pipe(Effect.mapError(toFailure)),
  ),
  order_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("order_send");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId, { active: true });
      const { delivery } = yield* captains.sendToOrder({
        captain,
        orderId: input.orderId,
        text: input.text,
        mode: input.mode ?? "queue",
      });
      return { orderId: input.orderId, delivery };
    }).pipe(Effect.mapError(toFailure)),
  ),
  order_drop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("order_drop");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId, { active: true });
      yield* captains.dropOrder({ captain, orderId: input.orderId, reason: input.reason });
      return { orderId: input.orderId, state: "dropped" as const };
    }).pipe(Effect.mapError(toFailure)),
  ),
  order_answer: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("order_answer");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId, { active: true });
      const { delivery, resolved } = yield* captains.answerOrder({
        captain,
        orderId: input.orderId,
        text: input.text,
      });
      return { orderId: input.orderId, delivery, resolved };
    }).pipe(Effect.mapError(toFailure)),
  ),
  order_retry: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("order_retry");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId, { active: true });
      const order = yield* captains.retryOrder({
        captain,
        orderId: input.orderId,
        brief: input.brief,
      });
      return { orderId: order.id, state: order.state, retries: order.retries };
    }).pipe(Effect.mapError(toFailure)),
  ),
  order_land: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("order_land");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId, { active: true });
      const { order, needsApproval } = yield* captains.landOrder({
        captain,
        orderId: input.orderId,
        delivery: input.delivery,
        approved: false,
      });
      return {
        orderId: order.id,
        state: order.state,
        delivery: order.delivery,
        needsApproval,
      };
    }).pipe(Effect.mapError(toFailure)),
  ),
  escalate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("escalate");
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* captains.requireCaptain(threadId, { active: true });
      const escalation = yield* captains.escalate({
        captain,
        orderId: input.orderId,
        kind: input.kind,
        summary: input.summary,
        detail: input.detail,
        options: input.options,
      });
      return { escalationId: escalation.id };
    }).pipe(Effect.mapError(toFailure)),
  ),
  review_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("review_submit");
      const captains = yield* CaptainService.CaptainService;
      const order = yield* captains.submitReview({ threadId, review: input });
      return { orderId: order.id, state: order.state };
    }).pipe(Effect.mapError(toFailure)),
  ),
  crew_worktree_check: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      CaptainService.CaptainService.pipe(
        Effect.flatMap((captains) => captains.worktreeCheck(input)),
        Effect.mapError(hostedFailure),
      ),
  ),
  crew_worktree_push: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      CaptainService.CaptainService.pipe(
        Effect.flatMap((captains) => captains.worktreePush(input)),
        Effect.mapError(hostedFailure),
      ),
  ),
  crew_approval: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      CaptainService.CaptainService.pipe(
        Effect.flatMap((captains) => captains.crewApprovals(input)),
        Effect.mapError(hostedFailure),
      ),
  ),
  crew_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread("crew_report");
      const captains = yield* CaptainService.CaptainService;
      const order = yield* captains.crewReport({ threadId, report: input });
      return { orderId: order.id, state: order.state };
    }).pipe(Effect.mapError(toFailure)),
  ),
});
