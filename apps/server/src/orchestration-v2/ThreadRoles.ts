import type { CaptainId, CaptainOrderId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type ThreadRole = "captain" | "crew" | "reviewer";

export interface ThreadRoleEntry {
  readonly role: ThreadRole;
  readonly captainId: CaptainId;
  readonly orderId?: CaptainOrderId;
  readonly instructions: string;
}

/**
 * The threads that a captain gives a role, in memory. The role decides which MCP tools a thread
 * is offered, so the session manager reads it to know when a live provider session has gone
 * stale, and turn start reads it to add the role's instructions.
 */
export class ThreadRoles extends Context.Service<
  ThreadRoles,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<ThreadRoleEntry | undefined>;
    readonly set: (threadId: ThreadId, entry: ThreadRoleEntry | undefined) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadRoles") {}

export const layer = Layer.effect(
  ThreadRoles,
  Effect.gen(function* () {
    const roles = yield* Ref.make<ReadonlyMap<ThreadId, ThreadRoleEntry>>(new Map());
    // Read on every MCP request and turn start, so a span per call would only be noise.
    const get = Effect.fnUntraced(function* (threadId: ThreadId) {
      return (yield* Ref.get(roles)).get(threadId);
    });
    const set = Effect.fnUntraced(function* (
      threadId: ThreadId,
      entry: ThreadRoleEntry | undefined,
    ) {
      yield* Ref.update(roles, (current) => {
        const next = new Map(current);
        if (entry === undefined) next.delete(threadId);
        else next.set(threadId, entry);
        return next;
      });
    });
    return ThreadRoles.of({ get, set });
  }),
);
