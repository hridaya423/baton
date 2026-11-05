import {
  CaptainMcpCrewReportInput,
  CaptainMcpCrewReportResult,
  CaptainMcpOrderCreateInput,
  CaptainMcpOrderCreateResult,
  CaptainMcpOrderDropInput,
  CaptainMcpOrderDropResult,
  CaptainMcpOrderListResult,
  CaptainMcpOrderReadInput,
  CaptainMcpOrderReadResult,
  CaptainMcpOrderSendInput,
  CaptainMcpOrderSendResult,
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
  CrewReportTool,
);
