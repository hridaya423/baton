import type { CaptainReviewFinding, CaptainVerifyResult } from "@t3tools/contracts";

export const REVIEW_DIFF_MAX_BYTES = 200 * 1024;
const AGENTS_MD_MAX_CHARS = 20_000;

export const verifyFailedMessage = (verify: CaptainVerifyResult) =>
  [
    "The done-check failed. Fix it and call crew_report done again.",
    `Command: ${verify.cmd}`,
    `Exit code: ${verify.exit === null ? "none (timed out or could not run)" : verify.exit}`,
    `Last output:\n${verify.logTail}`,
  ].join("\n");

const formatFindings = (findings: ReadonlyArray<CaptainReviewFinding>) =>
  findings.length === 0
    ? "(no findings listed)"
    : findings
        .map(
          (finding) =>
            `- [${finding.severity}] ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}: ${finding.scenario}`,
        )
        .join("\n");

export const reviewRejectedMessage = (
  reviewer: string,
  findings: ReadonlyArray<CaptainReviewFinding>,
) =>
  [
    `A reviewer (${reviewer}) rejected your change. Fix these and call crew_report done again.`,
    formatFindings(findings),
  ].join("\n");

export const reviewerBrief = (input: {
  readonly captainName: string;
  readonly orderId: string;
  readonly title: string;
  readonly brief: string;
  readonly round: number;
  readonly baseRef: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly diff:
    | { readonly text: string }
    | { readonly files: string }
    | { readonly unreadable: string };
  readonly agentsMd: string | undefined;
  readonly previousFindings: ReadonlyArray<CaptainReviewFinding>;
}) =>
  [
    `Review order ${input.orderId} for captain "${input.captainName}" (round ${input.round}): ${input.title}`,
    `Brief the crew was given:\n${input.brief}`,
    ...(input.previousFindings.length === 0
      ? []
      : [
          `The last review rejected the change with these findings. Check each of them first:\n${formatFindings(input.previousFindings)}`,
        ]),
    "text" in input.diff
      ? `git diff ${input.baseRef}...${input.branch}:\n${input.diff.text}`
      : "files" in input.diff
        ? `The diff of ${input.baseRef}...${input.branch} is over ${REVIEW_DIFF_MAX_BYTES / 1024} KB, so these are only the changed files. Read them in the worktree at ${input.worktreePath}:\n${input.diff.files}`
        : `The diff of ${input.baseRef}...${input.branch} could not be read (${input.diff.unreadable}). Run it yourself in the worktree at ${input.worktreePath}.`,
    ...(input.agentsMd === undefined
      ? []
      : [`The repository's AGENTS.md:\n${input.agentsMd.slice(0, AGENTS_MD_MAX_CHARS)}`]),
    "Review for correctness bugs, regressions against the brief, and violations of AGENTS.md. Give a file, a line if you know it, and the scenario that breaks for each problem. Do not change any file. End by calling review_submit once: verdict approve, or reject with your findings.",
  ].join("\n\n");

export const rebaseConflictMessage = (base: string, files: ReadonlyArray<string>) =>
  `Rebase onto ${base} conflicted in: ${files.join(", ")}. Resolve it and call crew_report done again.`;

export const rebaseFailedMessage = (base: string, reason: string) =>
  `Rebase onto ${base} failed: ${reason}. Resolve it and call crew_report done again.`;

export const pullRequestBody = (input: {
  readonly captainName: string;
  readonly orderId: string;
  readonly brief: string;
  readonly summary: string | undefined;
  readonly reviewer: string | undefined;
}) =>
  [
    input.summary === undefined ? undefined : `## Summary\n${input.summary}`,
    `## Brief\n${input.brief}`,
    `Opened by captain "${input.captainName}" for order ${input.orderId}${input.reviewer === undefined ? "" : `, reviewed by ${input.reviewer}`}.`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
