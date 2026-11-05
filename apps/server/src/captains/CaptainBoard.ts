import {
  type CaptainBoardOrder,
  type CaptainOrder,
  captainReviewThreadId,
} from "@t3tools/contracts";

const SUMMARY_MAX_CHARS = 300;

export const toBoardOrder = (order: CaptainOrder): CaptainBoardOrder => ({
  id: order.id,
  captainId: order.captainId,
  threadId: order.threadId,
  kind: order.kind,
  title: order.title,
  delivery: order.delivery,
  state: order.state,
  retries: order.retries,
  branch: order.branch,
  dependsOn: order.dependsOn,
  placement: order.placement,
  lastReport:
    order.lastReport === null
      ? null
      : {
          status: order.lastReport.status,
          summary: order.lastReport.summary.slice(0, SUMMARY_MAX_CHARS),
          at: order.lastReport.at,
        },
  verify:
    order.verify === null
      ? null
      : { cmd: order.verify.cmd, exit: order.verify.exit, finishedAt: order.verify.finishedAt },
  review:
    order.review === null
      ? null
      : {
          round: order.review.round,
          model: order.review.model,
          sameProvider: order.review.sameProvider,
          verdict: order.review.verdict,
          findingsCount: order.review.findings.length,
          threadIds: Array.from({ length: order.review.round }, (_, index) =>
            captainReviewThreadId(order.id, index + 1),
          ),
        },
  land: order.land,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});
