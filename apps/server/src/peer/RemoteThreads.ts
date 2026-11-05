import type {
  EnvironmentId,
  OrchestratorMcpThreadTimelineItem,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Tool from "effect/ai/Tool";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import type * as PeerForwarding from "./PeerForwarding.ts";

type Forwarding = PeerForwarding.PeerForwarding["Service"];

/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);

/** How a follower retries; tests step it by hand. */
export const FollowRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/peer/RemoteDelegation/FollowRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
        ),
      ),
  },
);

/** The projects in a linked environment whose repository is `key`. */
export const projectsWithRepository = Effect.fn("RemoteThreads.projectsWithRepository")(function* (
  forwarding: Forwarding,
  scope: McpInvocationContext.McpInvocationScope,
  environmentId: EnvironmentId,
  key: string,
) {
  const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
      yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
        cursor,
        limit: 100,
      });
    matches.push(
      ...listed.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
    );
    cursor = listed.nextCursor;
  }
  return matches;
});

/**
 * The last reply `runId` gave on a thread in a linked environment, read whole however long it is.
 * A failed run prefers its error from the activity view over an earlier reply, without taking
 * another run's.
 */
export const lastReply = Effect.fn("RemoteThreads.lastReply")(function* (
  forwarding: Forwarding,
  scope: McpInvocationContext.McpInvocationScope,
  remote: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  runId: RunId | null,
  failed = false,
) {
  let reply: OrchestratorMcpThreadTimelineItem | undefined;
  let error: OrchestratorMcpThreadTimelineItem | undefined;
  let afterPosition: number | undefined;
  while (true) {
    const read = yield* forwarding.readThread(scope, remote.environmentId, {
      threadId: remote.threadId,
      view: failed ? "activity" : "messages",
      limit: 100,
      ...(afterPosition === undefined ? {} : { afterPosition }),
    });
    reply =
      read.items.findLast(
        (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
      ) ?? reply;
    if (failed) {
      error =
        read.items.findLast(
          (item) => item.type === "error" && (runId === null || item.runId === runId),
        ) ?? error;
    }
    if (!read.hasMore || read.nextPosition === null) break;
    afterPosition = read.nextPosition;
  }
  reply = error ?? reply;
  if (reply === undefined) return undefined;
  let text = reply.text ?? "";
  let textOffset = reply.textTruncated ? (reply.nextTextOffset ?? null) : null;
  while (textOffset !== null) {
    const rest = yield* forwarding.readThread(scope, remote.environmentId, {
      threadId: remote.threadId,
      itemId: reply.itemId,
      textOffset,
      maxCharsPerItem: 50_000,
    });
    const part = rest.items[0];
    if (part === undefined) break;
    text += part.text ?? "";
    textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
  }
  return text;
});

/** The last `count` user and assistant messages of a thread in a linked environment, oldest first. */
export const recentMessages = Effect.fn("RemoteThreads.recentMessages")(function* (
  forwarding: Forwarding,
  scope: McpInvocationContext.McpInvocationScope,
  remote: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  count: number,
  maxChars: number,
) {
  const messages: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];
  let afterPosition: number | undefined;
  while (true) {
    const read = yield* forwarding.readThread(scope, remote.environmentId, {
      threadId: remote.threadId,
      view: "messages",
      limit: 100,
      ...(afterPosition === undefined ? {} : { afterPosition }),
    });
    for (const item of read.items) {
      if (item.type !== "user_message" && item.type !== "assistant_message") continue;
      messages.push({
        role: item.type === "user_message" ? "user" : "assistant",
        text: Array.from(item.text ?? "")
          .slice(0, maxChars)
          .join(""),
      });
    }
    if (!read.hasMore || read.nextPosition === null) break;
    afterPosition = read.nextPosition;
  }
  return messages.slice(-count);
});
