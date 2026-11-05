import {
  type Captain,
  CaptainError,
  type CaptainEscalation,
  type CaptainOrder,
  type CaptainOrderId,
  type CaptainVerifyResult,
  type EnvironmentId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { OpenEscalationInput } from "./CaptainService.ts";
import type * as CaptainStore from "./CaptainStore.ts";
import type { ReviewDiff } from "./CrewWorktree.ts";
import { type RemoteActor, REMOTE_BASE_REF, type RemoteCrew } from "./RemoteCrew.ts";
import type * as DueHint from "../scheduling/DueHint.ts";
import { FollowRetrySchedule } from "../peer/RemoteThreads.ts";

const FOLLOW_WAIT_MS = 30_000;
const IDLE_POLL = Duration.seconds(15);
export const REMOTE_RETRY_MS = 60_000;
const SUMMARY_MAX_CHARS = 8_000;
const REPORT_MAX_CHARS = 120_000;
const DETAIL_MAX_CHARS = 300;

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  return characters.length > DETAIL_MAX_CHARS
    ? `${characters.slice(0, DETAIL_MAX_CHARS).join("")}…`
    : flat;
};

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const cap = (text: string, max: number) => Array.from(text).slice(0, max).join("");

const isTerminal = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

export interface RemoteOrdersDeps {
  readonly store: CaptainStore.CaptainStore["Service"];
  readonly remote: Ref.Ref<RemoteCrew | undefined>;
  readonly providerInstanceOf: (
    captain: Captain,
  ) => Effect.Effect<RemoteActor["providerInstanceId"] | undefined, CaptainError>;
  readonly crewReport: (input: {
    readonly threadId: ThreadId;
    readonly report: {
      readonly status: "working" | "blocked" | "done";
      readonly summary: string;
      readonly reportMd?: string | undefined;
      readonly asks?: ReadonlyArray<string> | undefined;
    };
  }) => Effect.Effect<CaptainOrder, CaptainError>;
  readonly touchActivity: (orderId: CaptainOrderId) => Effect.Effect<void, CaptainError>;
  readonly note: (
    captain: Captain,
    order: CaptainOrder | null,
    key: string,
    text: string,
  ) => Effect.Effect<void>;
  readonly openEscalation: (
    input: OpenEscalationInput,
  ) => Effect.Effect<CaptainEscalation, CaptainError>;
  readonly failOrder: (
    captain: Captain,
    order: CaptainOrder,
    reason: string,
  ) => Effect.Effect<void, CaptainError>;
  readonly due: ReturnType<typeof DueHint.make>;
  readonly nowIso: Effect.Effect<string>;
  readonly scope: Scope.Scope;
}

export type RemoteLaunchResult = "launched" | "waiting" | "failed";

interface FollowState {
  readonly handled: Set<RunId>;
  readonly seen: Set<string>;
  signature: string | undefined;
  offline: boolean;
}

export const makeRemoteOrders = Effect.fn("RemoteOrders.make")(function* (deps: RemoteOrdersDeps) {
  const followRetry = yield* FollowRetrySchedule;
  const { store, remote, due } = deps;
  const waits = new Map<CaptainOrderId, string>();
  const followers = new Map<CaptainOrderId, Fiber.Fiber<void>>();
  const settling = new Set<CaptainOrderId>();

  const dispatchError =
    (captain: Captain, order: CaptainOrder) => (error: OrchestratorMcpFailure) =>
      new CaptainError({
        reason: "dispatch",
        captainId: captain.id,
        orderId: order.id,
        ...(order.threadId === null ? {} : { threadId: order.threadId }),
        detail: error.message,
        cause: error,
      });

  const driver = Effect.fn("RemoteOrders.driver")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const crew = yield* Ref.get(remote);
    const providerInstanceId = yield* deps.providerInstanceOf(captain);
    if (crew === undefined || order.environmentId === null || providerInstanceId === undefined) {
      return yield* new CaptainError({
        reason: "dispatch",
        captainId: captain.id,
        orderId: order.id,
        detail: "Linked environments are not available on this server.",
      });
    }
    const actor = { captainId: captain.id, threadId: captain.threadId, providerInstanceId };
    return { crew, actor, environmentId: order.environmentId };
  });

  type Driver = Effect.Success<ReturnType<typeof driver>>;

  const run = <A>(
    captain: Captain,
    order: CaptainOrder,
    use: (driver: Driver) => Effect.Effect<A, OrchestratorMcpFailure>,
  ) =>
    driver(captain, order).pipe(
      Effect.flatMap((found) => use(found).pipe(Effect.mapError(dispatchError(captain, order)))),
    );

  const labelOf = (found: Driver) =>
    found.crew.link(found.actor, found.environmentId).pipe(
      Effect.map((link) => link?.label ?? found.environmentId),
      Effect.orElseSucceed(() => found.environmentId),
    );

  const waiting = Effect.fn("RemoteOrders.waiting")(function* (
    captain: Captain,
    order: CaptainOrder,
    reason: string,
  ) {
    if (waits.get(order.id) === reason) return;
    waits.set(order.id, reason);
    yield* deps.note(
      captain,
      order,
      `waiting:${order.id}:${reason}:${yield* Clock.currentTimeMillis}`,
      `waiting: ${reason}`,
    );
  });

  const clearWait = (orderId: CaptainOrderId) => Effect.sync(() => void waits.delete(orderId));

  const hasWaits = () => waits.size > 0;

  /** Puts a gate that could not reach the machine back for the next pass. */
  const holdGate = Effect.fn("RemoteOrders.holdGate")(function* (
    captain: Captain,
    order: CaptainOrder,
    state: CaptainOrder["state"],
    reason: string,
  ) {
    yield* store.patchOrder({
      orderId: order.id,
      from: [state],
      at: yield* deps.nowIso,
      releaseClaim: true,
    });
    yield* waiting(captain, order, reason);
  });

  const launch = Effect.fn("RemoteOrders.launch")(function* (input: {
    readonly captain: Captain;
    readonly order: CaptainOrder;
    readonly workspaceRoot: string | undefined;
    readonly text: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: "default" | "plan";
    readonly branch: string;
  }) {
    const { captain, order } = input;
    const environmentId = order.environmentId;
    const found = yield* driver(captain, order).pipe(Effect.option);
    if (environmentId === null || Option.isNone(found)) {
      yield* waiting(captain, order, "linked environments are not available on this server");
      return "waiting" as RemoteLaunchResult;
    }
    const { crew, actor } = found.value;
    const failed = (reason: string) =>
      deps.failOrder(captain, order, reason).pipe(Effect.as("failed" as RemoteLaunchResult));
    const pause = (reason: string) =>
      waiting(captain, order, reason).pipe(Effect.as("waiting" as RemoteLaunchResult));

    const link = yield* Effect.result(crew.link(actor, environmentId));
    if (link._tag === "Failure") return yield* pause(link.failure.message);
    if (link.success === undefined) {
      return yield* failed(
        `${environmentId} is not linked. t3_environment_links lists the machines this one can use.`,
      );
    }
    const { label } = link.success;
    if (link.success.access !== "full-access") {
      return yield* failed(
        `The link to ${label} is paired with ${link.success.access} access. Remote orders need full access.`,
      );
    }
    if (link.success.status === "expired") {
      return yield* pause(`the link to ${label} expired; link it again`);
    }
    if (link.success.status === "unreachable") return yield* pause(`${label} is offline`);

    if (input.workspaceRoot === undefined) {
      return yield* failed("The project has no folder to match on the other machine.");
    }
    const project = yield* Effect.result(
      crew.resolveProject(actor, environmentId, input.workspaceRoot),
    );
    if (project._tag === "Failure") return yield* pause(project.failure.message);
    if (project.success.kind === "unidentified") {
      return yield* failed(
        `The project has no git remote, so no project on ${label} can be matched to it.`,
      );
    }
    if (project.success.kind === "none") {
      return yield* pause(
        `${label} has no project for this repository. Clone it there with t3_project_clone and environmentId ${environmentId}, then register it with t3_project_create`,
      );
    }
    if (project.success.kind === "many") {
      return yield* pause(
        `several projects on ${label} have this repository (${project.success.titles.join(", ")}); keep one`,
      );
    }

    const launched = yield* Effect.result(
      crew.launch(actor, environmentId, {
        projectId: project.success.projectId,
        title: order.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        message: input.text,
        clientRequestId: `captain-order:${order.id}:launch`,
      }),
    );
    if (launched._tag === "Failure") {
      return launched.failure.code === "invalid_request"
        ? yield* failed(`${label} refused the crew: ${launched.failure.message}`)
        : yield* pause(launched.failure.message);
    }
    const at = yield* deps.nowIso;
    const claimed = yield* store.claimOrder({
      orderId: order.id,
      threadId: launched.success.threadId,
      branch: input.branch,
      baseRef: REMOTE_BASE_REF,
      at,
    });
    if (!claimed) {
      yield* crew
        .interrupt(actor, environmentId, launched.success.threadId, {
          reason: "The order was dropped before its crew started.",
          key: `captain-order:${order.id}:unclaimed`,
          stop: true,
        })
        .pipe(Effect.ignoreCause({ log: true }));
      return "failed" as RemoteLaunchResult;
    }
    yield* clearWait(order.id);
    yield* due.invalidate;
    const running = yield* store.getOrder(order.id);
    if (Option.isSome(running)) yield* ensureFollower(captain, running.value);
    return "launched" as RemoteLaunchResult;
  });

  const verify = Effect.fn("RemoteOrders.verify")(function* (
    captain: Captain,
    order: CaptainOrder,
    cmd: string,
    timeoutMinutes: number,
  ) {
    const startedAt = yield* deps.nowIso;
    const threadId = order.threadId;
    if (threadId === null) return undefined;
    const checked = yield* Effect.result(
      run(captain, order, (found) =>
        found.crew.check(found.actor, found.environmentId, {
          threadId,
          command: cmd,
          timeoutMinutes,
        }),
      ),
    );
    if (checked._tag === "Failure") {
      const { cause } = checked.failure;
      if (isMcpFailure(cause) && cause.code === "invalid_request") {
        return {
          cmd,
          exit: null,
          logTail: clip(cause.message),
          startedAt,
          finishedAt: yield* deps.nowIso,
        } satisfies CaptainVerifyResult;
      }
      yield* holdGate(
        captain,
        order,
        "verifying",
        `the check on ${yield* label(captain, order)} could not run: ${checked.failure.detail ?? "no answer"}`,
      );
      return undefined;
    }
    yield* clearWait(order.id);
    return {
      cmd,
      exit: checked.success.check?.exit ?? null,
      logTail: checked.success.check?.logTail ?? "",
      startedAt,
      finishedAt: yield* deps.nowIso,
    } satisfies CaptainVerifyResult;
  });

  /** The crew's diff for the reviewer, or `undefined` once the gate is held for the next pass. */
  const reviewDiff = Effect.fn("RemoteOrders.reviewDiff")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const threadId = order.threadId;
    if (threadId === null) return { unreadable: "The crew has no thread." } satisfies ReviewDiff;
    const checked = yield* Effect.result(
      run(captain, order, (found) =>
        found.crew.check(found.actor, found.environmentId, {
          threadId,
          baseRef: order.baseRef ?? REMOTE_BASE_REF,
        }),
      ),
    );
    if (checked._tag === "Failure") {
      yield* holdGate(
        captain,
        order,
        "reviewing",
        `the diff on ${yield* label(captain, order)} could not be read: ${checked.failure.detail ?? "no answer"}`,
      );
      return undefined;
    }
    yield* clearWait(order.id);
    return (
      checked.success.diff ?? ({ unreadable: "The machine sent no diff." } satisfies ReviewDiff)
    );
  });

  const push = (captain: Captain, order: CaptainOrder, branch: string) =>
    Effect.suspend(() => {
      const threadId = order.threadId;
      return threadId === null
        ? Effect.fail(
            new CaptainError({
              reason: "crew_not_running",
              captainId: captain.id,
              orderId: order.id,
            }),
          )
        : run(captain, order, (found) =>
            found.crew.push(found.actor, found.environmentId, { threadId, branch }),
          );
    });

  const recentMessages = Effect.fn("RemoteOrders.recentMessages")(function* (
    captain: Captain,
    order: CaptainOrder,
    count: number,
    maxChars: number,
  ) {
    const threadId = order.threadId;
    if (threadId === null) return [];
    return yield* run(captain, order, (found) =>
      found.crew.messages(found.actor, found.environmentId, threadId, count, maxChars),
    );
  });

  const label = (captain: Captain, order: CaptainOrder) =>
    driver(captain, order).pipe(
      Effect.flatMap(labelOf),
      Effect.orElseSucceed(() => order.environmentId ?? "another machine"),
    );

  const surfaceRequests = Effect.fn("RemoteOrders.surfaceRequests")(function* (
    captain: Captain,
    order: CaptainOrder,
    state: FollowState,
  ) {
    const threadId = order.threadId as ThreadId;
    const pending = yield* run(captain, order, (found) =>
      found.crew.pending(found.actor, found.environmentId, threadId),
    );
    for (const request of pending.questions) {
      if (state.seen.has(request.requestId)) continue;
      state.seen.add(request.requestId);
      const asks = request.questions.map((question) => question.question);
      yield* deps.crewReport({
        threadId,
        report: {
          status: "blocked",
          summary: cap(asks.join(" / "), SUMMARY_MAX_CHARS),
          asks: asks.map((ask) => cap(ask, 2_000)),
        },
      });
    }
    for (const approval of pending.approvals) {
      if (state.seen.has(approval.requestId)) continue;
      state.seen.add(approval.requestId);
      yield* deps.openEscalation({
        captainId: captain.id,
        orderId: order.id,
        kind: "approval",
        summary: `${order.title} needs approval: ${clip(approval.prompt)}`,
        detail: "Approve or deny it here.",
        options: ["approve", "deny"],
        requestId: approval.requestId,
        wake: true,
      });
    }
  });

  const settleRun = Effect.fn("RemoteOrders.settleRun")(function* (
    captain: Captain,
    order: CaptainOrder,
    runId: RunId,
    status: string,
  ) {
    const threadId = order.threadId as ThreadId;
    const environmentId = order.environmentId as EnvironmentId;
    if (status === "completed") {
      const reply = yield* run(captain, order, (found) =>
        found.crew.reply(found.actor, environmentId, threadId, runId, false),
      );
      yield* deps.crewReport({
        threadId,
        report: {
          status: "done",
          summary: cap(reply ?? "(The crew finished without a reply.)", SUMMARY_MAX_CHARS).trim(),
          ...(order.kind === "report" && reply !== undefined
            ? { reportMd: cap(reply, REPORT_MAX_CHARS) }
            : {}),
        },
      });
      return;
    }
    if (status === "failed") {
      const failure = yield* run(captain, order, (found) =>
        found.crew.reply(found.actor, environmentId, threadId, runId, true),
      );
      yield* deps.note(
        captain,
        order,
        `run:${runId}:failed`,
        failure === undefined ? "failed" : `failed: ${clip(failure)}`,
      );
      return;
    }
    yield* deps.note(captain, order, `run:${runId}:${status}`, "was interrupted");
  });

  /** One look at an order's crew; true once there is nothing more to follow. */
  const step = Effect.fn("RemoteOrders.step")(function* (
    orderId: CaptainOrderId,
    state: FollowState,
  ) {
    const found = yield* store.getOrder(orderId);
    if (Option.isNone(found)) return true;
    const order = found.value;
    if (order.state !== "running" || order.environmentId === null || order.threadId === null) {
      return true;
    }
    const captain = yield* store.getCaptain(order.captainId);
    if (Option.isNone(captain) || captain.value.status !== "active") return true;
    const threadId = order.threadId;
    const environmentId = order.environmentId;
    const read = yield* run(captain.value, order, (driverFound) =>
      driverFound.crew.read(driverFound.actor, environmentId, threadId),
    );
    if (state.offline) {
      state.offline = false;
      yield* deps.note(
        captain.value,
        order,
        `online:${order.id}:${yield* Clock.currentTimeMillis}`,
        `back in contact with ${yield* label(captain.value, order)}`,
      );
    }
    const { thread } = read;
    const signature = `${thread.updatedAt}|${thread.itemCount}|${thread.status}`;
    if (signature !== state.signature || thread.pendingRequestCount > 0) {
      state.signature = signature;
      yield* deps.touchActivity(order.id);
    }
    if (thread.pendingRequestCount > 0) yield* surfaceRequests(captain.value, order, state);
    const target = thread.activeRunId ?? thread.latestRunId;
    if (target === null || state.handled.has(target)) {
      yield* Effect.sleep(IDLE_POLL);
      return false;
    }
    const waited = yield* run(captain.value, order, (driverFound) =>
      driverFound.crew.wait(driverFound.actor, environmentId, threadId, target, FOLLOW_WAIT_MS),
    );
    if (waited.timedOut || !isTerminal(waited.status)) return false;
    yield* settleRun(captain.value, order, target, waited.status);
    state.handled.add(target);
    return false;
  });

  /** Why the machine can no longer be followed, to say once. */
  const lost = Effect.fn("RemoteOrders.lost")(function* (orderId: CaptainOrderId, reason: string) {
    const found = yield* store.getOrder(orderId);
    if (Option.isNone(found)) return;
    const captain = yield* store.getCaptain(found.value.captainId);
    if (Option.isNone(captain)) return;
    yield* deps.openEscalation({
      captainId: captain.value.id,
      orderId,
      kind: "decision",
      summary: `${found.value.title}: lost its crew on another machine`,
      detail: reason,
      options: ["order_retry", "order_drop"],
      wake: true,
    });
  });

  const follow = (orderId: CaptainOrderId): Effect.Effect<void> => {
    const state: FollowState = {
      handled: new Set(),
      seen: new Set(),
      signature: undefined,
      offline: false,
    };
    return step(orderId, state).pipe(
      Effect.repeat({ while: (done) => !done }),
      Effect.catchTags({
        CaptainError: (error) => {
          const cause = error.cause;
          if (isMcpFailure(cause) && isFinal(cause)) {
            return lost(orderId, cause.message);
          }
          return Effect.gen(function* () {
            if (!state.offline) {
              state.offline = true;
              const found = yield* store.getOrder(orderId);
              const captain = Option.isSome(found)
                ? yield* store.getCaptain(found.value.captainId)
                : Option.none();
              if (Option.isSome(found) && Option.isSome(captain)) {
                yield* deps.note(
                  captain.value,
                  found.value,
                  `offline:${orderId}:${yield* Clock.currentTimeMillis}`,
                  `lost contact with ${yield* label(captain.value, found.value)}: ${error.detail ?? "no answer"}`,
                );
              }
            }
            return yield* error;
          });
        },
      }),
      Effect.retry(followRetry),
      Effect.ignoreCause({ log: true }),
    );
  };

  const ensureFollower = Effect.fn("RemoteOrders.ensureFollower")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    if (
      captain.status !== "active" ||
      order.environmentId === null ||
      order.state !== "running" ||
      order.threadId === null ||
      settling.has(order.id) ||
      followers.has(order.id)
    ) {
      return;
    }
    const fiber = yield* follow(order.id).pipe(
      Effect.ensuring(Effect.sync(() => void followers.delete(order.id))),
      Effect.forkIn(deps.scope),
    );
    followers.set(order.id, fiber);
  });

  const ensureAll = Effect.fn("RemoteOrders.ensureAll")(function* () {
    for (const order of yield* store.listInState("running")) {
      if (order.environmentId === null) continue;
      const captain = yield* store.getCaptain(order.captainId);
      if (Option.isSome(captain)) yield* ensureFollower(captain.value, order);
    }
  });

  const cancelFollower = (orderId: CaptainOrderId) =>
    Effect.suspend(() => {
      const fiber = followers.get(orderId);
      followers.delete(orderId);
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

  /**
   * Holds back this order's follower while its crew is being turned around, so the follower never
   * reads the run that just ended as the new turn's result.
   */
  const settlingWhile = <A, E, R>(orderId: CaptainOrderId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => void settling.add(orderId)),
      () => effect,
      () => Effect.sync(() => void settling.delete(orderId)),
    );

  return {
    driver,
    run,
    label,
    launch,
    verify,
    reviewDiff,
    push,
    recentMessages,
    waiting,
    clearWait,
    hasWaits,
    ensureFollower,
    ensureAll,
    cancelFollower,
    settlingWhile,
  };
});

export type RemoteOrders = Effect.Success<ReturnType<typeof makeRemoteOrders>>;
