import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const CaptainId = TrimmedNonEmptyString.pipe(Schema.brand("CaptainId"));
export type CaptainId = typeof CaptainId.Type;

export const CaptainOrderId = TrimmedNonEmptyString.pipe(Schema.brand("CaptainOrderId"));
export type CaptainOrderId = typeof CaptainOrderId.Type;

export const CaptainStatus = Schema.Literals(["active", "paused", "released"]);
export type CaptainStatus = typeof CaptainStatus.Type;

export const CaptainOrderKind = Schema.Literals(["change", "report"]);
export type CaptainOrderKind = typeof CaptainOrderKind.Type;

export const CaptainOrderDelivery = Schema.Literals(["none", "branch", "pr", "merge"]);
export type CaptainOrderDelivery = typeof CaptainOrderDelivery.Type;

export const CaptainOrderState = Schema.Literals(["queued", "running", "done", "dropped"]);
export type CaptainOrderState = typeof CaptainOrderState.Type;

export const CaptainCharter = Schema.Struct({
  crewCap: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  defaultDelivery: CaptainOrderDelivery,
  crewRuntimeMode: RuntimeMode,
  retryLimit: NonNegativeInt,
  stallMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  defaultModel: Schema.optional(ModelSelection),
  reviewModel: Schema.optional(ModelSelection),
});
export type CaptainCharter = typeof CaptainCharter.Type;

export const DEFAULT_CAPTAIN_CHARTER: CaptainCharter = {
  crewCap: 3,
  defaultDelivery: "branch",
  crewRuntimeMode: "full-access",
  retryLimit: 1,
  stallMinutes: 45,
};

export const CaptainPlacement = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
});
export type CaptainPlacement = typeof CaptainPlacement.Type;

export const CaptainCrewReportStatus = Schema.Literals(["working", "blocked", "done"]);
export type CaptainCrewReportStatus = typeof CaptainCrewReportStatus.Type;

export const CaptainCrewReport = Schema.Struct({
  status: CaptainCrewReportStatus,
  summary: Schema.String,
  asks: Schema.Array(Schema.String),
  at: IsoDateTime,
});
export type CaptainCrewReport = typeof CaptainCrewReport.Type;

export const Captain = Schema.Struct({
  id: CaptainId,
  projectId: ProjectId,
  threadId: ThreadId,
  name: TrimmedNonEmptyString,
  status: CaptainStatus,
  charter: CaptainCharter,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Captain = typeof Captain.Type;

export const CaptainOrder = Schema.Struct({
  id: CaptainOrderId,
  captainId: CaptainId,
  threadId: Schema.NullOr(ThreadId),
  kind: CaptainOrderKind,
  title: TrimmedNonEmptyString,
  brief: Schema.String,
  doneCheck: Schema.NullOr(Schema.String),
  touches: Schema.Array(Schema.String),
  dependsOn: Schema.Array(CaptainOrderId),
  placement: CaptainPlacement,
  delivery: CaptainOrderDelivery,
  state: CaptainOrderState,
  retries: NonNegativeInt,
  branch: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  reportMd: Schema.NullOr(Schema.String),
  lastReport: Schema.NullOr(CaptainCrewReport),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type CaptainOrder = typeof CaptainOrder.Type;

export class CaptainError extends Schema.TaggedError<CaptainError>()("CaptainError", {
  reason: Schema.Literals([
    "thread_not_found",
    "thread_is_subagent",
    "thread_already_captain",
    "thread_is_crew",
    "captain_not_found",
    "captain_not_active",
    "order_not_found",
    "not_a_captain",
    "not_crew",
    "invalid_order",
    "crew_not_running",
    "storage",
    "dispatch",
  ]),
  threadId: Schema.optional(ThreadId),
  captainId: Schema.optional(CaptainId),
  orderId: Schema.optional(CaptainOrderId),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : ` ${this.detail}`;
    switch (this.reason) {
      case "thread_not_found":
        return `The thread was not found.${detail}`;
      case "thread_is_subagent":
        return `A subagent thread cannot be a captain.${detail}`;
      case "thread_already_captain":
        return `This thread is already a captain.${detail}`;
      case "thread_is_crew":
        return `A crew thread cannot be a captain.${detail}`;
      case "captain_not_found":
        return `The captain was not found.${detail}`;
      case "captain_not_active":
        return `The captain is not active.${detail}`;
      case "order_not_found":
        return `The order was not found.${detail}`;
      case "not_a_captain":
        return `Only a captain thread can use this tool.${detail}`;
      case "not_crew":
        return `Only a crew thread can use this tool.${detail}`;
      case "invalid_order":
        return `The order is not valid.${detail}`;
      case "crew_not_running":
        return `The order has no running crew thread.${detail}`;
      case "storage":
        return `Captain storage failed.${detail}`;
      case "dispatch":
        return `Could not reach the thread.${detail}`;
    }
  }
}

export const CaptainCreateInput = Schema.Struct({
  threadId: ThreadId,
  name: Schema.optional(TrimmedNonEmptyString),
});
export type CaptainCreateInput = typeof CaptainCreateInput.Type;

export const CaptainCreateResult = Schema.Struct({ captain: Captain });
export type CaptainCreateResult = typeof CaptainCreateResult.Type;

export const CaptainListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type CaptainListInput = typeof CaptainListInput.Type;

export const CaptainListResult = Schema.Struct({ captains: Schema.Array(Captain) });
export type CaptainListResult = typeof CaptainListResult.Type;

export const CaptainReleaseInput = Schema.Struct({ captainId: CaptainId });
export type CaptainReleaseInput = typeof CaptainReleaseInput.Type;

export const CaptainReleaseResult = Schema.Struct({ captain: Captain });
export type CaptainReleaseResult = typeof CaptainReleaseResult.Type;

const OrderTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const OrderText = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));

export const CaptainMcpOrderCreateInput = Schema.Struct({
  title: OrderTitle,
  brief: OrderText.annotate({
    description: "Everything the crew needs. It sees no captain history.",
  }),
  kind: CaptainOrderKind.annotate({
    description: "change makes commits. report returns a write-up.",
  }),
  doneCheck: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Shell command that must exit 0." }),
  ),
  touches: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description:
        "Path globs a change order edits. Orders with overlapping touches run one at a time. Empty means unknown, so it waits for other change orders.",
    }),
  ),
  dependsOn: Schema.optional(Schema.Array(CaptainOrderId)),
  delivery: Schema.optional(CaptainOrderDelivery),
  placement: Schema.optional(CaptainPlacement),
});
export type CaptainMcpOrderCreateInput = typeof CaptainMcpOrderCreateInput.Type;

export const CaptainMcpOrderCreateResult = Schema.Struct({
  orderId: CaptainOrderId,
  position: NonNegativeInt,
  state: CaptainOrderState,
  link: Schema.optional(Schema.String),
});
export type CaptainMcpOrderCreateResult = typeof CaptainMcpOrderCreateResult.Type;

export const CaptainMcpOrderSummary = Schema.Struct({
  orderId: CaptainOrderId,
  title: Schema.String,
  kind: CaptainOrderKind,
  state: CaptainOrderState,
  delivery: CaptainOrderDelivery,
  branch: Schema.NullOr(Schema.String),
  waitingOn: Schema.Array(CaptainOrderId),
  lastReport: Schema.NullOr(CaptainCrewReport),
  threadId: Schema.NullOr(ThreadId),
  link: Schema.optional(Schema.String),
});
export type CaptainMcpOrderSummary = typeof CaptainMcpOrderSummary.Type;

export const CaptainMcpOrderListResult = Schema.Struct({
  captain: Schema.Struct({ name: Schema.String, status: CaptainStatus, crewCap: NonNegativeInt }),
  counts: Schema.Struct({
    queued: NonNegativeInt,
    running: NonNegativeInt,
    done: NonNegativeInt,
    dropped: NonNegativeInt,
  }),
  orders: Schema.Array(CaptainMcpOrderSummary),
});
export type CaptainMcpOrderListResult = typeof CaptainMcpOrderListResult.Type;

export const CaptainMcpOrderReadInput = Schema.Struct({ orderId: CaptainOrderId });
export type CaptainMcpOrderReadInput = typeof CaptainMcpOrderReadInput.Type;

export const CaptainMcpOrderReadResult = Schema.Struct({
  order: CaptainOrder,
  link: Schema.optional(Schema.String),
  recentMessages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
});
export type CaptainMcpOrderReadResult = typeof CaptainMcpOrderReadResult.Type;

export const CaptainMcpOrderSendInput = Schema.Struct({
  orderId: CaptainOrderId,
  text: OrderText,
  mode: Schema.optional(
    Schema.Literals(["queue", "steer"]).annotate({
      description: "queue (default) runs after the current turn. steer joins it.",
    }),
  ),
});
export type CaptainMcpOrderSendInput = typeof CaptainMcpOrderSendInput.Type;

export const CaptainMcpOrderSendResult = Schema.Struct({
  orderId: CaptainOrderId,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type CaptainMcpOrderSendResult = typeof CaptainMcpOrderSendResult.Type;

export const CaptainMcpOrderDropInput = Schema.Struct({
  orderId: CaptainOrderId,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type CaptainMcpOrderDropInput = typeof CaptainMcpOrderDropInput.Type;

export const CaptainMcpOrderDropResult = Schema.Struct({
  orderId: CaptainOrderId,
  state: Schema.Literal("dropped"),
});
export type CaptainMcpOrderDropResult = typeof CaptainMcpOrderDropResult.Type;

export const CaptainMcpCrewReportInput = Schema.Struct({
  status: CaptainCrewReportStatus,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  reportMd: Schema.optional(
    OrderText.annotate({ description: "The write-up, for a report order." }),
  ),
  asks: Schema.optional(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)))),
});
export type CaptainMcpCrewReportInput = typeof CaptainMcpCrewReportInput.Type;

export const CaptainMcpCrewReportResult = Schema.Struct({
  orderId: CaptainOrderId,
  state: CaptainOrderState,
});
export type CaptainMcpCrewReportResult = typeof CaptainMcpCrewReportResult.Type;
