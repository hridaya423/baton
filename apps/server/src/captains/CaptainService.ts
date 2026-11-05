import {
  type Captain,
  CaptainError,
  type CaptainCreateInput,
  type CaptainCrewReportStatus,
  type CaptainId,
  type CaptainListInput,
  type CaptainMcpCrewReportInput,
  type CaptainMcpOrderCreateInput,
  type CaptainOrder,
  CaptainOrderId,
  CommandId,
  DEFAULT_CAPTAIN_CHARTER,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CAPTAIN_INSTRUCTIONS, crewInstructions } from "./captainInstructions.ts";
import * as CaptainStore from "./CaptainStore.ts";
import { selectAdmissions, slug } from "./OrderPlanner.ts";

export type CaptainRole =
  | { readonly role: "captain"; readonly captainId: CaptainId }
  | { readonly role: "crew"; readonly captainId: CaptainId; readonly orderId: CaptainOrderId };

export type CrewSignal = {
  readonly captainId: CaptainId;
  readonly order: CaptainOrder;
  readonly key: string;
} & (
  | {
      readonly kind: "report";
      readonly status: CaptainCrewReportStatus;
      readonly summary: string;
      readonly asks: ReadonlyArray<string>;
    }
  | { readonly kind: "launch_failed"; readonly reason: string }
);

export interface CrewOf {
  readonly captain: Captain;
  readonly order: CaptainOrder;
}

const CREW_MD_MAX_CHARS = 8_000;
const READ_MESSAGE_LIMIT = 5;
const READ_MESSAGE_MAX_CHARS = 1_500;
const NEVER_DUE_MS = Number.MAX_SAFE_INTEGER;

export class CaptainService extends Context.Service<
  CaptainService,
  {
    readonly create: (input: CaptainCreateInput) => Effect.Effect<Captain, CaptainError>;
    readonly list: (input: CaptainListInput) => Effect.Effect<ReadonlyArray<Captain>, CaptainError>;
    readonly get: (captainId: CaptainId) => Effect.Effect<Option.Option<Captain>, CaptainError>;
    readonly release: (captainId: CaptainId) => Effect.Effect<Captain, CaptainError>;
    /** An in-memory answer, for tool visibility. Handlers check the database through the require methods. */
    readonly roleOf: (threadId: ThreadId) => Effect.Effect<CaptainRole | undefined>;
    readonly requireCaptain: (
      threadId: ThreadId,
      options?: { readonly active: true },
    ) => Effect.Effect<Captain, CaptainError>;
    readonly requireCrew: (threadId: ThreadId) => Effect.Effect<CrewOf, CaptainError>;
    readonly crewOf: (threadId: ThreadId) => Effect.Effect<Option.Option<CrewOf>, CaptainError>;
    readonly createOrder: (input: {
      readonly captain: Captain;
      readonly order: CaptainMcpOrderCreateInput;
      /** The most the crew may run at: the calling captain's own runtime mode. */
      readonly runtimeModeCeiling: RuntimeMode;
    }) => Effect.Effect<{ readonly order: CaptainOrder; readonly position: number }, CaptainError>;
    readonly listOrders: (
      captain: Captain,
    ) => Effect.Effect<ReadonlyArray<CaptainOrder>, CaptainError>;
    readonly readOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
    }) => Effect.Effect<
      {
        readonly order: CaptainOrder;
        readonly recentMessages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
      },
      CaptainError
    >;
    readonly sendToOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
      readonly text: string;
      readonly mode: ThreadManagementService.ThreadManagementSendMode;
    }) => Effect.Effect<
      { readonly delivery: "started" | "queued" | "steered" | "restarted" },
      CaptainError
    >;
    readonly dropOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
      readonly reason: string;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly crewReport: (input: {
      readonly threadId: ThreadId;
      readonly report: CaptainMcpCrewReportInput;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly touchActivity: (orderId: CaptainOrderId) => Effect.Effect<void, CaptainError>;
    readonly subscribeSignals: Effect.Effect<PubSub.Subscription<CrewSignal>, never, Scope.Scope>;
  }
>()("t3/captains/CaptainService") {}

const make = Effect.gen(function* () {
  const store = yield* CaptainStore.CaptainStore;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const scheduler = yield* Scheduler.Scheduler;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const roles = yield* Ref.make<ReadonlyMap<ThreadId, CaptainRole>>(new Map());
  const signals = yield* PubSub.unbounded<CrewSignal>();
  const admissionPermit = yield* Semaphore.make(1);
  const admissionDue = DueHint.make();

  const setRole = (threadId: ThreadId, role: CaptainRole | undefined) =>
    Ref.update(roles, (current) => {
      const next = new Map(current);
      if (role === undefined) next.delete(threadId);
      else next.set(threadId, role);
      return next;
    });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = random.uuidV4();

  const threadFailure = (threadId: ThreadId) => (cause: unknown) =>
    new CaptainError({ reason: "dispatch", threadId, cause });

  const getShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(threadFailure(threadId)));

  const dispatch = (threadId: ThreadId, command: Parameters<typeof threads.dispatch>[0]) =>
    threads.dispatch(command).pipe(Effect.mapError(threadFailure(threadId)));

  const requireCaptain: CaptainService["Service"]["requireCaptain"] = Effect.fn(
    "CaptainService.requireCaptain",
  )(function* (threadId, options) {
    const found = yield* store.getCaptainByThread(threadId);
    if (Option.isNone(found) || found.value.status === "released") {
      return yield* new CaptainError({ reason: "not_a_captain", threadId });
    }
    if (options?.active === true && found.value.status !== "active") {
      return yield* new CaptainError({
        reason: "captain_not_active",
        threadId,
        captainId: found.value.id,
      });
    }
    return found.value;
  });

  const crewOf: CaptainService["Service"]["crewOf"] = Effect.fn("CaptainService.crewOf")(
    function* (threadId) {
      const order = yield* store.getOrderByThread(threadId);
      if (Option.isNone(order) || order.value.state === "dropped") return Option.none();
      const captain = yield* store.getCaptain(order.value.captainId);
      return Option.map(captain, (found) => ({ captain: found, order: order.value }));
    },
  );

  const requireCrew: CaptainService["Service"]["requireCrew"] = Effect.fn(
    "CaptainService.requireCrew",
  )(function* (threadId) {
    return yield* crewOf(threadId).pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.mapError((error) =>
        error._tag === "CaptainError" ? error : new CaptainError({ reason: "not_crew", threadId }),
      ),
    );
  });

  const resolveBaseRef = Effect.fn("CaptainService.resolveBaseRef")(function* (cwd: string) {
    const defaultBranch = yield* git.resolvePrimaryRemoteName(cwd).pipe(
      Effect.flatMap((remote) => git.resolveDefaultBranchName(cwd, remote)),
      Effect.orElseSucceed(() => null),
    );
    const candidates = [defaultBranch, "main", "master", "HEAD"].filter(
      (candidate): candidate is string => candidate !== null,
    );
    for (const revision of candidates) {
      const resolved = yield* git.resolveCommit({ cwd, revision }).pipe(Effect.option);
      if (Option.isSome(resolved)) return resolved.value.commitSha;
    }
    return undefined;
  });

  const readCrewMd = Effect.fn("CaptainService.readCrewMd")(function* (projectId: ProjectId) {
    const file = path.join(config.baseDir, "captains", projectId, "CREW.md");
    const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
    return text === undefined || text.trim().length === 0
      ? undefined
      : text.trim().slice(0, CREW_MD_MAX_CHARS);
  });

  const crewMessage = Effect.fn("CaptainService.crewMessage")(function* (
    captain: Captain,
    order: CaptainOrder,
    orders: ReadonlyArray<CaptainOrder>,
  ) {
    const crewMd = yield* readCrewMd(captain.projectId);
    const built = order.dependsOn.flatMap((id) => {
      const dependency = orders.find((candidate) => candidate.id === id);
      return dependency?.lastReport === null || dependency === undefined
        ? []
        : [`- ${dependency.title}: ${dependency.lastReport?.summary}`];
    });
    return [
      order.brief,
      ...(crewMd === undefined ? [] : [`Standing orders (CREW.md):\n${crewMd}`]),
      ...(built.length === 0 ? [] : [`Finished orders you build on:\n${built.join("\n")}`]),
      crewInstructions(captain.name, order),
    ].join("\n\n");
  });

  const modelFor = (captain: Captain, order: CaptainOrder, captainModel: ModelSelection) => {
    const base = captain.charter.defaultModel ?? captainModel;
    const instanceId = order.placement.providerInstanceId ?? base.instanceId;
    const model = order.placement.model ?? base.model;
    return instanceId === base.instanceId && model === base.model
      ? base
      : ({ instanceId, model } satisfies ModelSelection);
  };

  const failOrder = Effect.fn("CaptainService.failOrder")(function* (
    captain: Captain,
    order: CaptainOrder,
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* store.transitionOrder({
      orderId: order.id,
      from: ["queued", "running"],
      to: "dropped",
      at,
    });
    if (order.threadId !== null) yield* setRole(order.threadId, undefined);
    yield* admissionDue.invalidate;
    yield* PubSub.publish(signals, {
      kind: "launch_failed",
      captainId: captain.id,
      order: { ...order, state: "dropped" },
      key: `launch-failed:${order.id}`,
      reason,
    });
  });

  const launchOrder = Effect.fn("CaptainService.launchOrder")(function* (
    captain: Captain,
    order: CaptainOrder,
    orders: ReadonlyArray<CaptainOrder>,
  ) {
    const captainShell = yield* getShell(captain.threadId);
    if (captainShell === null || captainShell.deletedAt !== null) return;
    const project = yield* projects
      .getById(captain.projectId)
      .pipe(Effect.mapError(threadFailure(captain.threadId)));
    const baseRef = Option.isNone(project)
      ? undefined
      : yield* resolveBaseRef(project.value.workspaceRoot);
    if (baseRef === undefined) {
      return yield* failOrder(
        captain,
        order,
        "The project has no commit to branch the crew worktree from.",
      );
    }
    const requested = order.placement.runtimeMode ?? captain.charter.crewRuntimeMode;
    const runtimeMode =
      runtimeModeRank(requested) > runtimeModeRank(captainShell.runtimeMode)
        ? captainShell.runtimeMode
        : requested;
    const threadId = ThreadId.make(`captain-crew:${order.id}`);
    const branch = `crew/${slug(captain.name, 24)}/${slug(order.title, 32)}-${order.id.slice(-6)}`;
    const at = yield* nowIso;
    const claimed = yield* store.claimOrder({ orderId: order.id, threadId, branch, baseRef, at });
    if (!claimed) return;
    yield* setRole(threadId, { role: "crew", captainId: captain.id, orderId: order.id });
    yield* admissionDue.invalidate;
    const text = yield* crewMessage(captain, order, orders);
    yield* launches
      .launch({
        commandId: CommandId.make(`captain-order:${order.id}:launch`),
        threadId,
        projectId: captain.projectId,
        title: order.title,
        modelSelection: modelFor(captain, order, captainShell.modelSelection),
        runtimeMode,
        interactionMode: captainShell.interactionMode,
        workspaceStrategy: { type: "worktree", baseRef, branch },
        initialMessage: {
          messageId: MessageId.make(`captain-order:${order.id}:brief`),
          senderThreadId: captain.threadId,
          text,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "server",
        groupedUnderThreadId: captain.threadId,
      })
      .pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("captain crew launch failed", {
              orderId: order.id,
              captainId: captain.id,
              cause,
            }).pipe(
              Effect.andThen(
                failOrder(captain, { ...order, threadId }, "The crew thread could not be started."),
              ),
            ),
        ),
      );
  });

  const admitCaptain = Effect.fn("CaptainService.admitCaptain")(function* (captain: Captain) {
    if (captain.status !== "active") return;
    const orders = yield* store.listOrders(captain.id);
    const ids = selectAdmissions({ crewCap: captain.charter.crewCap, orders });
    for (const id of ids) {
      const order = orders.find((candidate) => candidate.id === id);
      if (order !== undefined) yield* launchOrder(captain, order, orders);
    }
  });

  const admitAll = admissionPermit.withPermits(1)(
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      if (yield* admissionDue.isIdle(nowMs)) return;
      const version = yield* admissionDue.version;
      const captains = yield* store.listCaptains({});
      for (const captain of captains) {
        yield* admitCaptain(captain).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("captain admission failed", { captainId: captain.id, cause }),
          ),
        );
      }
      yield* admissionDue.record(version, NEVER_DUE_MS, nowMs);
    }),
  );

  const admitNow = (captain: Captain) =>
    admissionPermit
      .withPermits(1)(admitCaptain(captain))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("captain admission failed", { captainId: captain.id, cause }),
        ),
      );

  const create: CaptainService["Service"]["create"] = Effect.fn("CaptainService.create")(
    function* (input) {
      const shell = yield* getShell(input.threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
        return yield* new CaptainError({ reason: "thread_not_found", threadId: input.threadId });
      }
      if (shell.lineage.relationshipToParent === "subagent") {
        return yield* new CaptainError({ reason: "thread_is_subagent", threadId: input.threadId });
      }
      const current = (yield* Ref.get(roles)).get(input.threadId);
      if (current?.role === "crew") {
        return yield* new CaptainError({ reason: "thread_is_crew", threadId: input.threadId });
      }
      const existing = yield* store.getCaptainByThread(input.threadId);
      if (Option.isSome(existing) && existing.value.status !== "released") {
        return yield* new CaptainError({
          reason: "thread_already_captain",
          threadId: input.threadId,
          captainId: existing.value.id,
        });
      }
      const at = yield* nowIso;
      const captain: Captain = Option.isSome(existing)
        ? { ...existing.value, status: "active", updatedAt: at }
        : {
            id: `captain:${yield* newId}` as CaptainId,
            projectId: shell.projectId,
            threadId: shell.id,
            name: input.name ?? (shell.title.trim().length > 0 ? shell.title.trim() : "Captain"),
            status: "active",
            charter: DEFAULT_CAPTAIN_CHARTER,
            createdAt: at,
            updatedAt: at,
          };
      if (Option.isSome(existing)) {
        yield* store.setCaptainStatus({ captainId: captain.id, status: "active", at });
      } else {
        yield* store.insertCaptain(captain);
      }
      yield* setRole(captain.threadId, { role: "captain", captainId: captain.id });
      yield* admissionDue.invalidate;
      if (shell.pinnedAt == null) {
        yield* dispatch(captain.threadId, {
          type: "thread.pin",
          commandId: CommandId.make(`server:captain-pin:${yield* newId}`),
          threadId: captain.threadId,
        });
      }
      if (shell.autoSettleDisabledAt == null) {
        yield* dispatch(captain.threadId, {
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`server:captain-auto-settle:${yield* newId}`),
          threadId: captain.threadId,
          enabled: false,
        });
      }
      const uuid = yield* newId;
      yield* dispatch(captain.threadId, {
        type: "message.dispatch",
        commandId: CommandId.make(`server:captain-instructions:${uuid}`),
        threadId: captain.threadId,
        messageId: MessageId.make(`message:captain-instructions:${uuid}`),
        text: CAPTAIN_INSTRUCTIONS,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "This thread is now a captain",
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      return captain;
    },
  );

  const list: CaptainService["Service"]["list"] = (input) => store.listCaptains(input);

  const get: CaptainService["Service"]["get"] = (captainId) => store.getCaptain(captainId);

  const release: CaptainService["Service"]["release"] = Effect.fn("CaptainService.release")(
    function* (captainId) {
      const found = yield* store.getCaptain(captainId);
      if (Option.isNone(found))
        return yield* new CaptainError({ reason: "captain_not_found", captainId });
      if (found.value.status === "released") return found.value;
      const at = yield* nowIso;
      yield* store.setCaptainStatus({ captainId, status: "released", at });
      yield* setRole(found.value.threadId, undefined);
      yield* admissionDue.invalidate;
      yield* dispatch(found.value.threadId, {
        type: "queue.hold",
        commandId: CommandId.make(`server:captain-release:${yield* newId}`),
        threadId: found.value.threadId,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("holding a released captain's queue failed", {
            captainId,
            cause: error,
          }),
        ),
      );
      return { ...found.value, status: "released", updatedAt: at } satisfies Captain;
    },
  );

  const createOrder: CaptainService["Service"]["createOrder"] = Effect.fn(
    "CaptainService.createOrder",
  )(function* ({ captain, order: input, runtimeModeCeiling }) {
    if (captain.status !== "active") {
      return yield* new CaptainError({
        reason: "captain_not_active",
        captainId: captain.id,
        threadId: captain.threadId,
      });
    }
    const invalid = (detail: string) =>
      new CaptainError({ reason: "invalid_order", captainId: captain.id, detail });
    const orders = yield* store.listOrders(captain.id);
    const unknown = (input.dependsOn ?? []).filter(
      (id) => !orders.some((candidate) => candidate.id === id),
    );
    if (unknown.length > 0) {
      return yield* invalid(
        `dependsOn names orders this captain does not have: ${unknown.join(", ")}.`,
      );
    }
    const runtimeMode = input.placement?.runtimeMode ?? captain.charter.crewRuntimeMode;
    if (runtimeModeRank(runtimeMode) > runtimeModeRank(runtimeModeCeiling)) {
      return yield* invalid(
        `Crew would run at ${runtimeMode}, above this captain's ${runtimeModeCeiling}. Pass placement.runtimeMode ${runtimeModeCeiling} or lower.`,
      );
    }
    const captainShell = yield* getShell(captain.threadId);
    const baseInstance = (captain.charter.defaultModel ?? captainShell?.modelSelection)?.instanceId;
    if (
      input.placement?.providerInstanceId !== undefined &&
      input.placement.providerInstanceId !== baseInstance &&
      input.placement.model === undefined
    ) {
      return yield* invalid("Pass placement.model together with placement.providerInstanceId.");
    }
    const at = yield* nowIso;
    const created: CaptainOrder = {
      id: CaptainOrderId.make(`order:${yield* newId}`),
      captainId: captain.id,
      threadId: null,
      kind: input.kind,
      title: input.title,
      brief: input.brief,
      doneCheck: input.doneCheck ?? null,
      touches: input.touches ?? [],
      dependsOn: input.dependsOn ?? [],
      placement: { ...input.placement, runtimeMode },
      delivery: input.delivery ?? captain.charter.defaultDelivery,
      state: "queued",
      retries: 0,
      branch: null,
      baseRef: null,
      reportMd: null,
      lastReport: null,
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    yield* store.insertOrder(created);
    yield* admissionDue.invalidate;
    yield* admitNow(captain);
    const after = yield* store.listOrders(captain.id);
    const stored = after.find((candidate) => candidate.id === created.id) ?? created;
    const position =
      stored.state === "queued"
        ? after
            .filter((candidate) => candidate.state === "queued")
            .findIndex((c) => c.id === created.id) + 1
        : 0;
    return { order: stored, position };
  });

  const listOrders: CaptainService["Service"]["listOrders"] = (captain) =>
    store.listOrders(captain.id);

  const ownedOrder = Effect.fn("CaptainService.ownedOrder")(function* (
    captain: Captain,
    orderId: CaptainOrderId,
  ) {
    const found = yield* store.getOrder(orderId);
    if (Option.isNone(found) || found.value.captainId !== captain.id) {
      return yield* new CaptainError({ reason: "order_not_found", captainId: captain.id, orderId });
    }
    return found.value;
  });

  const readOrder: CaptainService["Service"]["readOrder"] = Effect.fn("CaptainService.readOrder")(
    function* ({ captain, orderId }) {
      const order = yield* ownedOrder(captain, orderId);
      if (order.threadId === null) return { order, recentMessages: [] };
      const crewThreadId = order.threadId;
      const records = yield* threads
        .getThreadRecords(crewThreadId, ["messages"], { messageRoles: ["user", "assistant"] })
        .pipe(Effect.mapError(threadFailure(crewThreadId)));
      const recentMessages = records.messages
        .toSorted(
          (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
        )
        .slice(-READ_MESSAGE_LIMIT)
        .map((message) => ({
          role: message.role,
          text: Array.from(message.text).slice(0, READ_MESSAGE_MAX_CHARS).join(""),
        }));
      return { order, recentMessages };
    },
  );

  const sendToOrder: CaptainService["Service"]["sendToOrder"] = Effect.fn(
    "CaptainService.sendToOrder",
  )(function* ({ captain, orderId, text, mode }) {
    const order = yield* ownedOrder(captain, orderId);
    if (order.state !== "running" || order.threadId === null) {
      return yield* new CaptainError({
        reason: "crew_not_running",
        captainId: captain.id,
        orderId,
      });
    }
    const crewThreadId = order.threadId;
    const uuid = yield* newId;
    const result = yield* threads
      .sendToThread({
        projectId: captain.projectId,
        commandId: CommandId.make(`mcp:captain-send:${uuid}`),
        threadId: crewThreadId,
        messageId: MessageId.make(`message:captain-send:${uuid}`),
        senderThreadId: captain.threadId,
        text,
        attachments: [],
        mode,
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(threadFailure(crewThreadId)));
    return { delivery: result.delivery };
  });

  const dropOrder: CaptainService["Service"]["dropOrder"] = Effect.fn("CaptainService.dropOrder")(
    function* ({ captain, orderId, reason }) {
      const order = yield* ownedOrder(captain, orderId);
      if (order.state === "dropped") return order;
      if (order.state === "done") {
        return yield* new CaptainError({
          reason: "invalid_order",
          captainId: captain.id,
          orderId,
          detail: "A finished order cannot be dropped.",
        });
      }
      const at = yield* nowIso;
      yield* store.transitionOrder({ orderId, from: ["queued", "running"], to: "dropped", at });
      if (order.threadId !== null) {
        const crewThreadId = order.threadId;
        yield* setRole(crewThreadId, undefined);
        yield* threads
          .interruptThread({
            projectId: captain.projectId,
            commandId: CommandId.make(`mcp:captain-drop:${yield* newId}`),
            threadId: crewThreadId,
            reason,
          })
          .pipe(
            Effect.andThen(
              dispatch(crewThreadId, {
                type: "queue.hold",
                commandId: CommandId.make(`server:captain-drop-hold:${yield* newId}`),
                threadId: crewThreadId,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("stopping a dropped crew thread failed", { orderId, cause: error }),
            ),
          );
      }
      yield* admissionDue.invalidate;
      yield* admitNow(captain);
      return { ...order, state: "dropped", updatedAt: at } satisfies CaptainOrder;
    },
  );

  const crewReport: CaptainService["Service"]["crewReport"] = Effect.fn(
    "CaptainService.crewReport",
  )(function* ({ threadId, report }) {
    const { captain, order } = yield* requireCrew(threadId);
    const at = yield* nowIso;
    const state = report.status === "done" ? "done" : order.state;
    const lastReport = {
      status: report.status,
      summary: report.summary,
      asks: report.asks ?? [],
      at,
    };
    yield* store.recordReport({
      orderId: order.id,
      report: lastReport,
      reportMd: report.reportMd,
      state,
      at,
    });
    yield* admissionDue.invalidate;
    yield* PubSub.publish(signals, {
      kind: "report",
      captainId: captain.id,
      order: { ...order, state, lastReport },
      key: `report:${order.id}:${at}`,
      status: report.status,
      summary: report.summary,
      asks: lastReport.asks,
    });
    if (state === "done" && order.state !== "done") yield* admitNow(captain);
    return {
      ...order,
      state,
      lastReport,
      reportMd: report.reportMd ?? order.reportMd,
      updatedAt: at,
    } satisfies CaptainOrder;
  });

  const touchActivity: CaptainService["Service"]["touchActivity"] = (orderId) =>
    nowIso.pipe(Effect.flatMap((at) => store.touchActivity({ orderId, at })));

  const roleOf: CaptainService["Service"]["roleOf"] = (threadId) =>
    Effect.map(Ref.get(roles), (current) => current.get(threadId));

  const startupCaptains = yield* store.listCaptains({});
  for (const captain of startupCaptains) {
    if (captain.status !== "released") {
      yield* setRole(captain.threadId, { role: "captain", captainId: captain.id });
    }
  }
  for (const order of yield* store.listCrewOrders()) {
    if (order.threadId !== null) {
      yield* setRole(order.threadId, {
        role: "crew",
        captainId: order.captainId,
        orderId: order.id,
      });
    }
  }
  yield* scheduler.register("captain-admission", admitAll);

  return CaptainService.of({
    create,
    list,
    get,
    release,
    roleOf,
    requireCaptain,
    requireCrew,
    crewOf,
    createOrder,
    listOrders,
    readOrder,
    sendToOrder,
    dropOrder,
    crewReport,
    touchActivity,
    subscribeSignals: PubSub.subscribe(signals),
  });
});

export const layer = Layer.effect(CaptainService, make);
