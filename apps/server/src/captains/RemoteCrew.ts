import {
  CaptainMcpCrewApprovalInput,
  CaptainMcpCrewApprovalResult,
  CaptainMcpCrewWorktreeCheckInput,
  CaptainMcpCrewWorktreeCheckResult,
  CaptainMcpCrewWorktreePushInput,
  CaptainMcpCrewWorktreePushResult,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool } from "effect/ai";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import type * as PeerForwarding from "../peer/PeerForwarding.ts";
import { lastReply, projectsWithRepository, recentMessages } from "../peer/RemoteThreads.ts";

// Schema-only copies of the `CaptainToolkit` tools a crew's machine serves: that module imports
// the captain service, which imports this one.
const CheckTool = Tool.make("crew_worktree_check", {
  parameters: CaptainMcpCrewWorktreeCheckInput,
  success: CaptainMcpCrewWorktreeCheckResult,
});
const PushTool = Tool.make("crew_worktree_push", {
  parameters: CaptainMcpCrewWorktreePushInput,
  success: CaptainMcpCrewWorktreePushResult,
});
const ApprovalTool = Tool.make("crew_approval", {
  parameters: CaptainMcpCrewApprovalInput,
  success: CaptainMcpCrewApprovalResult,
});

export const CREW_HOST_TOOL_NAMES = [CheckTool.name, PushTool.name, ApprovalTool.name] as const;

export const REMOTE_BASE_REF = "origin/HEAD";

export interface RemoteBundle {
  readonly forwarding: PeerForwarding.PeerForwarding["Service"];
  readonly environmentId: EnvironmentId;
  readonly repositoryKeyOf: (workspaceRoot: string) => Effect.Effect<string | undefined>;
}

/** The captain thread a call is made as: its modes cap what the crew there may do. */
export interface RemoteActor {
  readonly captainId: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export type RemoteProject =
  | { readonly kind: "found"; readonly projectId: ProjectId }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly titles: ReadonlyArray<string> }
  | { readonly kind: "unidentified" };

export interface RemoteLaunch {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string;
  readonly message: string;
  readonly clientRequestId: string;
}

/** Every call a captain's server makes to the machine a crew runs on. */
export const makeRemoteCrew = (bundle: RemoteBundle) => {
  const { forwarding } = bundle;

  const scopeOf = (actor: RemoteActor): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId: bundle.environmentId,
    requestNamespace: `captain-remote:${actor.captainId}`,
    thread: {
      threadId: actor.threadId,
      providerSessionId: `captain-remote:${actor.captainId}`,
      providerInstanceId: actor.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  const link = Effect.fn("RemoteCrew.link")(function* (
    actor: RemoteActor,
    environmentId: EnvironmentId,
  ) {
    const listed = yield* forwarding.links(scopeOf(actor));
    return listed.links.find((candidate) => candidate.environmentId === environmentId);
  });

  const resolveProject = Effect.fn("RemoteCrew.resolveProject")(function* (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) {
    const key = yield* bundle.repositoryKeyOf(workspaceRoot);
    if (key === undefined) return { kind: "unidentified" } satisfies RemoteProject;
    const matches = yield* projectsWithRepository(forwarding, scopeOf(actor), environmentId, key);
    if (matches.length === 1) {
      return { kind: "found", projectId: matches[0]!.id } satisfies RemoteProject;
    }
    return matches.length === 0
      ? ({ kind: "none" } satisfies RemoteProject)
      : ({ kind: "many", titles: matches.map((project) => project.title) } satisfies RemoteProject);
  });

  const launch = (actor: RemoteActor, environmentId: EnvironmentId, input: RemoteLaunch) =>
    forwarding.call(scopeOf(actor), ProjectToolkit.tools.t3_thread_launch, environmentId, {
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy: { type: "worktree", baseRef: REMOTE_BASE_REF, branch: input.branch },
      message: input.message,
      clientRequestId: input.clientRequestId,
    });

  const read = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    input: { readonly view?: "messages" | "activity"; readonly afterPosition?: number } = {},
  ) =>
    forwarding.readThread(scopeOf(actor), environmentId, {
      threadId,
      limit: input.afterPosition === undefined ? 1 : 100,
      runLimit: 5,
      ...(input.view === undefined ? {} : { view: input.view }),
      ...(input.afterPosition === undefined ? {} : { afterPosition: input.afterPosition }),
    });

  const wait = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    runId: RunId,
    timeoutMs: number,
  ) => forwarding.waitForThread(scopeOf(actor), environmentId, { threadId, runId, timeoutMs });

  const reply = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    runId: RunId,
    failed: boolean,
  ) => lastReply(forwarding, scopeOf(actor), { environmentId, threadId }, runId, failed);

  const messages = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    count: number,
    maxChars: number,
  ) => recentMessages(forwarding, scopeOf(actor), { environmentId, threadId }, count, maxChars);

  /** The questions and approvals a thread there waits on. */
  const pending = Effect.fn("RemoteCrew.pending")(function* (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    const scope = scopeOf(actor);
    const listed = yield* forwarding.call(
      scope,
      ThreadToolkit.tools.t3_pending_request,
      environmentId,
      { action: "list", threadId },
    );
    const questions: Array<{
      readonly requestId: RuntimeRequestId;
      readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string }>;
    }> = [];
    if ("requestIds" in listed) {
      for (const requestId of listed.requestIds) {
        const found = yield* forwarding.call(
          scope,
          ThreadToolkit.tools.t3_pending_request,
          environmentId,
          { action: "read", threadId, requestId },
        );
        if ("questions" in found) questions.push({ requestId, questions: found.questions });
      }
    }
    const approvals = yield* forwarding.call(scope, ApprovalTool, environmentId, { threadId });
    return { questions, approvals: approvals.approvals };
  });

  const answer = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    answers: Readonly<Record<string, string>>,
  ) =>
    forwarding.call(scopeOf(actor), ThreadToolkit.tools.t3_pending_request, environmentId, {
      action: "respond",
      threadId,
      requestId,
      answers,
    });

  const decide = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    decision: "accept" | "decline",
  ) =>
    forwarding.call(scopeOf(actor), ApprovalTool, environmentId, { threadId, requestId, decision });

  const send = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    input: {
      readonly text: string;
      readonly mode: "auto" | "queue" | "steer" | "restart";
      readonly key: string;
    },
  ) =>
    forwarding.call(scopeOf(actor), OrchestratorToolkit.tools.t3_thread_send, environmentId, {
      threadId,
      message: input.text,
      mode: input.mode,
      clientRequestId: input.key,
    });

  /** `stop` also holds the thread's queue and ends what it delegated, as the Stop button does. */
  const interrupt = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    input: { readonly reason: string; readonly key: string; readonly stop: boolean },
  ) =>
    forwarding.interruptThread(scopeOf(actor), environmentId, {
      threadId,
      reason: input.reason,
      stop: input.stop,
      clientRequestId: input.key,
    });

  const check = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    input: CaptainMcpCrewWorktreeCheckInput,
  ) => forwarding.call(scopeOf(actor), CheckTool, environmentId, input);

  const push = (
    actor: RemoteActor,
    environmentId: EnvironmentId,
    input: CaptainMcpCrewWorktreePushInput,
  ) => forwarding.call(scopeOf(actor), PushTool, environmentId, input);

  return {
    link,
    resolveProject,
    launch,
    read,
    wait,
    reply,
    messages,
    pending,
    answer,
    decide,
    send,
    interrupt,
    check,
    push,
  };
};

export type RemoteCrew = ReturnType<typeof makeRemoteCrew>;
