import {
  CaptainMcpCrewReportInput,
  CaptainMcpCrewReportResult,
  CaptainMcpEscalateInput,
  CaptainMcpEscalateResult,
  CaptainMcpOrderAnswerInput,
  CaptainMcpOrderAnswerResult,
  CaptainMcpOrderCreateInput,
  CaptainMcpOrderCreateResult,
  CaptainMcpOrderDropInput,
  CaptainMcpOrderDropResult,
  CaptainMcpOrderLandInput,
  CaptainMcpOrderLandResult,
  CaptainMcpOrderListResult,
  CaptainMcpOrderReadInput,
  CaptainMcpOrderReadResult,
  CaptainMcpOrderRetryInput,
  CaptainMcpOrderRetryResult,
  CaptainMcpOrderSendInput,
  CaptainMcpOrderSendResult,
  CaptainMcpReviewSubmitInput,
  CaptainMcpReviewSubmitResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as CaptainService from "../../../captains/CaptainService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CaptainService.CaptainService,
];

const OrderCreateTool = Tool.make("order_create", {
  description:
    "Hand work to a crew thread. Use this, not t3_thread_launch or delegate_task, for work you split out. `kind` change makes commits; report returns a write-up. Change orders with overlapping `touches` run one at a time. Crew wake you when they finish or ask. Do not poll.",
  parameters: CaptainMcpOrderCreateInput,
  success: CaptainMcpOrderCreateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create an order")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderListTool = Tool.make("order_list", {
  description:
    "The board: every order with its state and last report. Answer status questions from this, not memory.",
  success: CaptainMcpOrderListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List orders")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderReadTool = Tool.make("order_read", {
  description: "One order with its last report and its crew's last messages.",
  parameters: CaptainMcpOrderReadInput,
  success: CaptainMcpOrderReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read an order")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderSendTool = Tool.make("order_send", {
  description: "Message the crew of a running order.",
  parameters: CaptainMcpOrderSendInput,
  success: CaptainMcpOrderSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Message a crew")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderDropTool = Tool.make("order_drop", {
  description: "Stop an order and its crew thread. A queued order just leaves the queue.",
  parameters: CaptainMcpOrderDropInput,
  success: CaptainMcpOrderDropResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Drop an order")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderAnswerTool = Tool.make("order_answer", {
  description:
    "Answer a crew's question. It reaches the crew and closes any open decision for that order. Ask the user first when the answer is not yours to give.",
  parameters: CaptainMcpOrderAnswerInput,
  success: CaptainMcpOrderAnswerResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Answer a crew")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderRetryTool = Tool.make("order_retry", {
  description:
    "Stop an order's crew turn and send it a revised brief, or the original, in the same thread and worktree. Counts as a retry.",
  parameters: CaptainMcpOrderRetryInput,
  success: CaptainMcpOrderRetryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Retry an order")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const OrderLandTool = Tool.make("order_land", {
  description:
    "Deliver an accepted order, or retry one whose landing failed. `delivery` overrides the order's: none keeps the branch local, branch pushes it, pr opens a pull request. merge opens a needs-you approval for the user; you cannot merge yourself. Tell the user in one line when an approval is open.",
  parameters: CaptainMcpOrderLandInput,
  success: CaptainMcpOrderLandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Land an order")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const EscalateTool = Tool.make("escalate", {
  description:
    "Open a needs-you item for the user: a decision, a one-way door, a budget or a conflict. Then say it in one line with the choices.",
  parameters: CaptainMcpEscalateInput,
  success: CaptainMcpEscalateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCaptains);

const ReviewSubmitTool = Tool.make("review_submit", {
  description:
    "Submit your review of the order you were asked to review: approve, or reject with findings (severity, file, line, the scenario that breaks). Call it once, last.",
  parameters: CaptainMcpReviewSubmitInput,
  success: CaptainMcpReviewSubmitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Submit a review")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToReviewers);

const CrewReportTool = Tool.make("crew_report", {
  description:
    "Report on your order. `done` when finished (add `reportMd` for a report order). `blocked` with `asks` when stuck. Do not wait silently.",
  parameters: CaptainMcpCrewReportInput,
  success: CaptainMcpCrewReportResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Report on an order")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToCrew);

export const CaptainToolkit = Toolkit.make(
  OrderCreateTool,
  OrderListTool,
  OrderReadTool,
  OrderSendTool,
  OrderDropTool,
  OrderAnswerTool,
  OrderRetryTool,
  OrderLandTool,
  EscalateTool,
  CrewReportTool,
  ReviewSubmitTool,
);
