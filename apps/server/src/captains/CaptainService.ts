import {
  type Captain,
  CaptainError,
  CaptainCharter,
  type CaptainCharterPatch,
  type CaptainCreateInput,
  type CaptainCrewReportStatus,
  type CaptainEscalation,
  CaptainEscalationId,
  type CaptainEscalationKind,
  type CaptainId,
  type CaptainListInput,
  type CaptainMcpCrewReportInput,
  type CaptainMcpOrderCreateInput,
  type CaptainMcpReviewSubmitInput,
  type CaptainOrder,
  type CaptainOrderDelivery,
  CaptainOrderId,
  type CaptainReview,
  type CaptainUpdateInput,
  type CaptainVerifyResult,
  CommandId,
  DEFAULT_CAPTAIN_CHARTER,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  T3_CODE_CAPTAIN_ROLE_INSTRUCTIONS,
  t3CrewRoleInstructions,
  t3ReviewerRoleInstructions,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadRoles from "../orchestration-v2/ThreadRoles.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CaptainStore from "./CaptainStore.ts";
import { installCrewHooks } from "./CrewHooks.ts";
import { clipError, makeLandGit } from "./LandGit.ts";
import {
  REVIEW_DIFF_MAX_BYTES,
  pullRequestBody,
  rebaseConflictMessage,
  rebaseFailedMessage,
  reviewRejectedMessage,
  reviewerBrief,
  verifyFailedMessage,
} from "./captainMessages.ts";
import { selectAdmissions, slug } from "./OrderPlanner.ts";
import { pickReviewer } from "./ReviewerModels.ts";
import { holdsStall, stallLevelFor } from "./StallRules.ts";
import { runDoneCheck } from "./Verifier.ts";

export type CaptainRole =
  | { readonly role: "captain"; readonly captainId: CaptainId }
  | { readonly role: "crew"; readonly captainId: CaptainId; readonly orderId: CaptainOrderId }
  | { readonly role: "reviewer"; readonly captainId: CaptainId; readonly orderId: CaptainOrderId };

export type CrewSignal =
  | {
      readonly kind: "report";
      readonly captainId: CaptainId;
      readonly order: CaptainOrder;
      readonly key: string;
      readonly status: CaptainCrewReportStatus;
      readonly summary: string;
      readonly asks: ReadonlyArray<string>;
    }
  | {
      readonly kind: "launch_failed";
      readonly captainId: CaptainId;
      readonly order: CaptainOrder;
      readonly key: string;
      readonly reason: string;
    }
  | {
      readonly kind: "note";
      readonly captainId: CaptainId;
      readonly order: CaptainOrder | null;
      readonly key: string;
      readonly text: string;
    };

export interface CrewOf {
  readonly captain: Captain;
  readonly order: CaptainOrder;
}

export interface OpenEscalationInput {
  readonly captainId: CaptainId;
  readonly orderId: CaptainOrderId | null;
  readonly kind: CaptainEscalationKind;
  readonly summary: string;
  readonly detail: string;
  readonly options: ReadonlyArray<string>;
  readonly requestId?: string;
  /** False when the opener already told the captain. */
  readonly wake: boolean;
}

const CREW_MD_MAX_CHARS = 8_000;
const READ_MESSAGE_LIMIT = 5;
const READ_MESSAGE_MAX_CHARS = 1_500;
const NEVER_DUE_MS = Number.MAX_SAFE_INTEGER;
const STALL_RECHECK_MS = 60_000;
const CLAIM_TTL_MS = 3 * 60 * 60 * 1_000;
const REVIEW_REPROMPT =
  "You finished without calling review_submit. Call it now with your verdict: approve, or reject with your findings.";
const WORK_STATES = ["running", "verifying", "verify_failed", "reviewing"] as const;
const RETRY_STATES = [...WORK_STATES, "accepted", "land_failed"] as const;
const DROP_STATES = [...WORK_STATES, "queued", "accepted", "land_failed"] as const;
const MERGE_APPROVAL_PREFIX = "merge:";
const LAND_RETRY_LIMIT = 3;
const RESUME_NUDGE =
  "The captain resumed. Continue your order, or call crew_report if you are done or blocked.";

const mergeApprovalKey = (order: Pick<CaptainOrder, "id" | "retries">) =>
  `${MERGE_APPROVAL_PREFIX}${order.id}:${order.retries}`;

const isMergeApproval = (escalation: Pick<CaptainEscalation, "requestId">) =>
  escalation.requestId?.startsWith(MERGE_APPROVAL_PREFIX) === true;

const mergeDecision = (resolution: string): "merge" | "hold" | undefined => {
  if (/^\s*(merge|approve|approved|yes)\b/i.test(resolution)) return "merge";
  if (/^\s*(hold|deny|denied|decline|no)\b/i.test(resolution)) return "hold";
  return undefined;
};

const approvalDecision = (resolution: string): "accept" | "decline" | undefined => {
  if (/^\s*(approve|approved|accept|yes)\b/i.test(resolution)) return "accept";
  if (/^\s*(deny|denied|decline|reject|no)\b/i.test(resolution)) return "decline";
  return undefined;
};

const decodeCharter = Schema.decodeUnknownEffect(CaptainCharter);

const times = (count: number) => (count === 2 ? "twice" : `${count} times`);

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
    readonly requireReviewer: (threadId: ThreadId) => Effect.Effect<CrewOf, CaptainError>;
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
    readonly answerOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
      readonly text: string;
    }) => Effect.Effect<
      {
        readonly delivery: "started" | "queued" | "steered" | "restarted";
        readonly resolved: number;
      },
      CaptainError
    >;
    readonly retryOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
      readonly brief: string | undefined;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly dropOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
      readonly reason: string;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    /** A merge asks the user first unless `approved`, which only a user's own action sets. */
    readonly landOrder: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId;
      readonly delivery: CaptainOrderDelivery | undefined;
      readonly approved: boolean;
    }) => Effect.Effect<
      { readonly order: CaptainOrder; readonly needsApproval: boolean },
      CaptainError
    >;
    readonly listOrdersOf: (
      captainId: CaptainId,
    ) => Effect.Effect<ReadonlyArray<CaptainOrder>, CaptainError>;
    readonly landOrderById: (input: {
      readonly orderId: CaptainOrderId;
      readonly delivery: CaptainOrderDelivery | undefined;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly retryOrderById: (input: {
      readonly orderId: CaptainOrderId;
      readonly brief: string | undefined;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly dropOrderById: (input: {
      readonly orderId: CaptainOrderId;
      readonly reason: string | undefined;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly update: (input: CaptainUpdateInput) => Effect.Effect<Captain, CaptainError>;
    readonly crewReport: (input: {
      readonly threadId: ThreadId;
      readonly report: CaptainMcpCrewReportInput;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly submitReview: (input: {
      readonly threadId: ThreadId;
      readonly review: CaptainMcpReviewSubmitInput;
    }) => Effect.Effect<CaptainOrder, CaptainError>;
    readonly reviewerEnded: (threadId: ThreadId) => Effect.Effect<void, CaptainError>;
    readonly openEscalation: (
      input: OpenEscalationInput,
    ) => Effect.Effect<CaptainEscalation, CaptainError>;
    readonly escalate: (input: {
      readonly captain: Captain;
      readonly orderId: CaptainOrderId | undefined;
      readonly kind: CaptainEscalationKind;
      readonly summary: string;
      readonly detail: string | undefined;
      readonly options: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<CaptainEscalation, CaptainError>;
    readonly listEscalations: (input: {
      readonly captainId?: CaptainId | undefined;
      readonly status?: "open" | "resolved" | undefined;
    }) => Effect.Effect<ReadonlyArray<CaptainEscalation>, CaptainError>;
    readonly resolveEscalation: (input: {
      readonly escalationId: CaptainEscalationId;
      readonly resolution: string;
    }) => Effect.Effect<CaptainEscalation, CaptainError>;
    readonly touchActivity: (orderId: CaptainOrderId) => Effect.Effect<void, CaptainError>;
    /** Runs everything due now and waits for the verifications and reviewer launches it starts. */
    readonly drain: Effect.Effect<void, CaptainError>;
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
  const threadRoles = yield* ThreadRoles.ThreadRoles;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const landGit = makeLandGit(git);
  const scope = yield* Effect.scope;

  const signals = yield* PubSub.unbounded<CrewSignal>();
  const permit = yield* Semaphore.make(1);
  const due = DueHint.make();
  const workFibers = new Map<CaptainOrderId, Fiber.Fiber<void>>();
  const projectLocks = new Map<ProjectId, Semaphore.Semaphore>();
  const kicked = new Map<symbol, Fiber.Fiber<void>>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const newId = random.uuidV4();

  const threadFailure = (threadId: ThreadId) => (cause: unknown) =>
    new CaptainError({ reason: "dispatch", threadId, cause });

  const getShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(threadFailure(threadId)));

  const dispatch = (threadId: ThreadId, command: Parameters<typeof threads.dispatch>[0]) =>
    threads.dispatch(command).pipe(Effect.mapError(threadFailure(threadId)));

  const assignRole = (
    threadId: ThreadId,
    role: CaptainRole,
    instructions: string,
  ): Effect.Effect<void> =>
    threadRoles.set(threadId, {
      role: role.role,
      captainId: role.captainId,
      ...(role.role === "captain" ? {} : { orderId: role.orderId }),
      instructions,
    });

  const clearRole = (threadId: ThreadId) => threadRoles.set(threadId, undefined);

  const crewRole = (captain: Captain, order: CaptainOrder) =>
    assignRole(
      order.threadId as ThreadId,
      { role: "crew", captainId: captain.id, orderId: order.id },
      t3CrewRoleInstructions({
        captainName: captain.name,
        orderId: order.id,
        kind: order.kind,
        doneCheck: order.doneCheck,
      }),
    );

  const reviewerRole = (captain: Captain, order: CaptainOrder, threadId: ThreadId) =>
    assignRole(
      threadId,
      { role: "reviewer", captainId: captain.id, orderId: order.id },
      t3ReviewerRoleInstructions({ captainName: captain.name, orderId: order.id }),
    );

  const note = (captain: Captain, order: CaptainOrder | null, key: string, text: string) =>
    PubSub.publish(signals, { kind: "note", captainId: captain.id, order, key, text });

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

  const requireReviewer: CaptainService["Service"]["requireReviewer"] = Effect.fn(
    "CaptainService.requireReviewer",
  )(function* (threadId) {
    const entry = yield* threadRoles.get(threadId);
    const notReviewer = new CaptainError({ reason: "not_reviewer", threadId });
    if (entry?.role !== "reviewer" || entry.orderId === undefined) return yield* notReviewer;
    const order = yield* store.getOrder(entry.orderId);
    const captain = yield* store.getCaptain(entry.captainId);
    if (
      Option.isNone(order) ||
      Option.isNone(captain) ||
      order.value.state !== "reviewing" ||
      order.value.review === null ||
      order.value.review.threadId !== threadId ||
      order.value.review.finishedAt !== null
    ) {
      return yield* notReviewer;
    }
    return { captain: captain.value, order: order.value };
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
    if (order.threadId !== null) yield* clearRole(order.threadId);
    yield* due.invalidate;
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
    const crewing = { ...order, threadId, branch, baseRef, state: "running" as const };
    yield* crewRole(captain, crewing);
    yield* due.invalidate;
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
    const launched = yield* store.getOrder(order.id);
    if (Option.isNone(launched) || launched.value.state !== "running") return;
    yield* guardWorktree(captain, crewing).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("installing the crew push guard failed", {
            orderId: order.id,
            cause,
          }).pipe(
            Effect.andThen(
              stopThread(
                captain,
                crewing,
                threadId,
                "The push guard could not be installed.",
                true,
              ),
            ),
            Effect.andThen(
              failOrder(
                captain,
                crewing,
                "The crew's push guard could not be installed, so it was not allowed to run.",
              ),
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

  const admitNow = (captain: Captain) =>
    permit
      .withPermits(1)(admitCaptain(captain))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("captain admission failed", { captainId: captain.id, cause }),
        ),
      );

  const sendFollowUp = Effect.fn("CaptainService.sendFollowUp")(function* (
    captain: Captain,
    order: CaptainOrder,
    text: string,
    key: string,
  ) {
    if (order.threadId === null) {
      return yield* new CaptainError({
        reason: "crew_not_running",
        captainId: captain.id,
        orderId: order.id,
      });
    }
    const crewThreadId = order.threadId;
    return yield* threads
      .sendToThread({
        projectId: captain.projectId,
        commandId: CommandId.make(`server:captain-followup:${key}`),
        threadId: crewThreadId,
        messageId: MessageId.make(`message:captain-followup:${key}`),
        senderThreadId: captain.threadId,
        text,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.mapError(threadFailure(crewThreadId)));
  });

  const openEscalation: CaptainService["Service"]["openEscalation"] = Effect.fn(
    "CaptainService.openEscalation",
  )(function* (input) {
    const existing = yield* store.findOpenEscalation({
      captainId: input.captainId,
      orderId: input.orderId,
      kind: input.kind,
      requestId: input.requestId ?? null,
    });
    if (Option.isSome(existing)) return existing.value;
    const escalation: CaptainEscalation = {
      id: CaptainEscalationId.make(`escalation:${yield* newId}`),
      captainId: input.captainId,
      orderId: input.orderId,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      options: input.options,
      status: "open",
      resolution: null,
      requestId: (input.requestId ?? null) as CaptainEscalation["requestId"],
      createdAt: yield* nowIso,
      resolvedAt: null,
    };
    yield* store.insertEscalation(escalation);
    if (input.wake) {
      const captain = yield* store.getCaptain(input.captainId);
      const order = input.orderId === null ? Option.none() : yield* store.getOrder(input.orderId);
      if (Option.isSome(captain)) {
        yield* note(
          captain.value,
          Option.getOrNull(order),
          `escalation:${escalation.id}`,
          `needs you: ${input.summary}`,
        );
      }
    }
    return escalation;
  });

  const settleFailedGate = Effect.fn("CaptainService.settleFailedGate")(function* (
    captain: Captain,
    order: CaptainOrder,
    label: string,
  ) {
    if (order.pendingFollowUp === null) return;
    yield* sendFollowUp(captain, order, order.pendingFollowUp, `${order.id}:${order.retries}`);
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from: ["verify_failed"],
      at: yield* nowIso,
      state: "running",
      pendingFollowUp: null,
    });
    if (moved) {
      yield* note(captain, order, `gate:${order.id}:${order.retries}:sent-back`, label);
    }
  });

  const retryLimitEscalation = (
    captain: Captain,
    order: CaptainOrder,
    what: string,
    detail: string,
  ) =>
    openEscalation({
      captainId: captain.id,
      orderId: order.id,
      kind: "retry_limit",
      summary: `${order.title}: ${what}`,
      detail,
      options: ["order_retry with a new brief", "order_drop"],
      wake: false,
    });

  const verifyFailureDetail = (verify: CaptainVerifyResult) =>
    `Command: ${verify.cmd}\nExit code: ${verify.exit === null ? "none" : verify.exit}\n${verify.logTail}`;

  const failVerification = Effect.fn("CaptainService.failVerification")(function* (
    captain: Captain,
    order: CaptainOrder,
    verify: CaptainVerifyResult,
    from: ReadonlyArray<CaptainOrder["state"]>,
  ) {
    const at = yield* nowIso;
    const retries = order.retries + 1;
    const exhausted = retries > captain.charter.retryLimit;
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from,
      at,
      state: "verify_failed",
      retries,
      verify,
      pendingFollowUp: exhausted ? null : verifyFailedMessage(verify),
    });
    if (!moved) return;
    const exit = verify.exit === null ? "no exit code" : `exit ${verify.exit}`;
    if (exhausted) {
      yield* note(
        captain,
        order,
        `verify:${order.id}:${retries}:limit`,
        `verify failed ${times(retries)}, needs you`,
      );
      yield* retryLimitEscalation(
        captain,
        order,
        `verify failed ${times(retries)}`,
        verifyFailureDetail(verify),
      );
      return;
    }
    yield* settleFailedGate(
      captain,
      { ...order, retries, verify, pendingFollowUp: verifyFailedMessage(verify) },
      `verify failed (${exit}), sent back`,
    );
  });

  const applyVerification = Effect.fn("CaptainService.applyVerification")(function* (
    captain: Captain,
    order: CaptainOrder,
    verify: CaptainVerifyResult,
  ) {
    if (verify.exit !== 0) return yield* failVerification(captain, order, verify, ["verifying"]);
    const at = yield* nowIso;
    const to = order.kind === "change" ? "reviewing" : "done";
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from: ["verifying"],
      at,
      state: to,
      verify,
    });
    if (!moved) return;
    yield* note(captain, order, `verify:${order.id}:${order.retries}:pass`, "verify passed");
    yield* to === "done" ? admitNow(captain) : kick;
  });

  const crewCwd = Effect.fn("CaptainService.crewCwd")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const shell = order.threadId === null ? null : yield* getShell(order.threadId);
    if (shell?.worktreePath != null) return shell.worktreePath;
    const project = yield* projects
      .getById(captain.projectId)
      .pipe(Effect.mapError(threadFailure(captain.threadId)));
    return Option.isSome(project) ? project.value.workspaceRoot : undefined;
  });

  const runVerification = Effect.fn("CaptainService.runVerification")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const cmd = order.doneCheck;
    const cwd = yield* crewCwd(captain, order);
    const timeoutMs = (captain.charter.verifyTimeoutMinutes ?? 10) * 60_000;
    const verify =
      cmd === null
        ? undefined
        : cwd === undefined
          ? ({
              cmd,
              exit: null,
              logTail: "The crew has no worktree to run the check in.",
              startedAt: yield* nowIso,
              finishedAt: yield* nowIso,
            } satisfies CaptainVerifyResult)
          : yield* runDoneCheck({ cmd, cwd, timeoutMs }).pipe(
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
            );
    if (verify !== undefined) yield* applyVerification(captain, order, verify);
  });

  const projectCwdOf = Effect.fn("CaptainService.projectCwdOf")(function* (captain: Captain) {
    const project = yield* projects
      .getById(captain.projectId)
      .pipe(Effect.mapError(threadFailure(captain.threadId)));
    return Option.isSome(project) ? project.value.workspaceRoot : undefined;
  });

  const crewWorktree = Effect.fn("CaptainService.crewWorktree")(function* (order: CaptainOrder) {
    const shell = order.threadId === null ? null : yield* getShell(order.threadId);
    const worktree = shell?.worktreePath;
    if (worktree == null) return undefined;
    const present = yield* fileSystem.exists(worktree).pipe(Effect.orElseSucceed(() => false));
    return present ? worktree : undefined;
  });

  const checkOrder = Effect.fn("CaptainService.checkOrder")(function* (
    captain: Captain,
    order: CaptainOrder,
    cwd: string,
  ) {
    if (order.doneCheck === null) return undefined;
    return yield* runDoneCheck({
      cmd: order.doneCheck,
      cwd,
      timeoutMs: (captain.charter.verifyTimeoutMinutes ?? 10) * 60_000,
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  });

  const guardWorktree = Effect.fn("CaptainService.guardWorktree")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const worktree = yield* crewWorktree(order);
    const projectCwd = yield* projectCwdOf(captain);
    if (worktree === undefined || projectCwd === undefined) return;
    yield* installCrewHooks({
      git,
      hooksDir: path.join(config.baseDir, "captains", captain.projectId, "hooks"),
      projectCwd,
      worktreePath: worktree,
      baseBranch: yield* landGit.baseBranch(projectCwd),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });

  const stopThread = (
    captain: Captain,
    order: CaptainOrder,
    threadId: ThreadId,
    reason: string,
    holdQueue: boolean,
  ) =>
    threads
      .interruptThread({
        projectId: captain.projectId,
        commandId: CommandId.make(`mcp:captain-stop:${threadId}:${order.id}:${order.retries}`),
        threadId,
        reason,
      })
      .pipe(
        Effect.andThen(
          holdQueue
            ? dispatch(threadId, {
                type: "queue.hold",
                commandId: CommandId.make(`server:captain-stop-hold:${threadId}:${order.id}`),
                threadId,
              })
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logWarning("stopping an order's thread failed", {
            orderId: order.id,
            cause: error,
          }),
        ),
      );

  const cleanupWorktree = Effect.fn("CaptainService.cleanupWorktree")(
    function* (captain: Captain, order: CaptainOrder, deleteBranch: boolean) {
      const cwd = yield* projectCwdOf(captain);
      if (cwd === undefined) return;
      const worktree = yield* crewWorktree(order);
      if (worktree !== undefined) {
        yield* git.removeWorktree({ cwd, path: worktree, force: false }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("removing a crew worktree failed", {
              orderId: order.id,
              cause: error,
            }),
          ),
        );
      }
      if (deleteBranch && order.branch !== null) {
        yield* git.deleteLocalBranch({ cwd, refName: order.branch, force: false }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("deleting a merged crew branch failed", {
              orderId: order.id,
              cause: error,
            }),
          ),
        );
      }
    },
    (effect, _captain, order) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning("cleaning up a crew worktree failed", {
                orderId: order.id,
                cause,
              }),
        ),
      ),
  );

  const projectLock = (projectId: ProjectId) => {
    const existing = projectLocks.get(projectId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    projectLocks.set(projectId, created);
    return created;
  };

  const landFailed = Effect.fn("CaptainService.landFailed")(function* (
    captain: Captain,
    order: CaptainOrder,
    action: "branch" | "pr" | "merge",
    error: string,
  ) {
    const at = yield* nowIso;
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from: ["landing"],
      at,
      state: "land_failed",
      land: { action, ok: false, error, at },
    });
    if (moved)
      yield* note(captain, order, `land:${order.id}:${at}:failed`, `land failed: ${error}`);
    return false;
  });

  const landSucceeded = Effect.fn("CaptainService.landSucceeded")(function* (
    captain: Captain,
    order: CaptainOrder,
    action: "branch" | "pr" | "merge",
    line: string,
    prUrl?: string,
  ) {
    const at = yield* nowIso;
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from: ["landing"],
      at,
      state: "landed",
      land: { action, ok: true, at, ...(prUrl === undefined ? {} : { prUrl }) },
      ...(prUrl === undefined ? {} : { prUrl }),
    });
    if (moved) yield* note(captain, order, `land:${order.id}:${at}:landed`, line);
    return moved;
  });

  const sendBackRebase = Effect.fn("CaptainService.sendBackRebase")(function* (
    captain: Captain,
    order: CaptainOrder,
    from: ReadonlyArray<CaptainOrder["state"]>,
    message: string,
  ) {
    const at = yield* nowIso;
    const retries = order.retries + 1;
    const exhausted = retries > captain.charter.retryLimit;
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from,
      at,
      state: "verify_failed",
      retries,
      pendingFollowUp: exhausted ? null : message,
    });
    if (!moved) return false;
    if (exhausted) {
      yield* note(
        captain,
        order,
        `rebase:${order.id}:${retries}:limit`,
        `rebase conflicted ${times(retries)}, needs you`,
      );
      yield* retryLimitEscalation(captain, order, `rebase conflicted ${times(retries)}`, message);
      return false;
    }
    yield* settleFailedGate(
      captain,
      { ...order, retries, pendingFollowUp: message },
      "rebase conflicted, sent back",
    );
    return false;
  });

  const rebaseAccepted = Effect.fn("CaptainService.rebaseAccepted")(function* (
    captain: Captain,
    order: CaptainOrder,
    base: string,
  ) {
    const worktree = yield* crewWorktree(order);
    if (worktree === undefined) return;
    if ((yield* landGit.currentBranch(worktree)) !== order.branch) return;
    const rebase = yield* landGit.rebaseOnto(worktree, base);
    if (rebase.kind === "up_to_date") return;
    if (rebase.kind === "conflict") {
      yield* sendBackRebase(
        captain,
        order,
        ["accepted"],
        rebaseConflictMessage(base, rebase.files),
      );
      return;
    }
    if (rebase.kind === "error") {
      yield* sendBackRebase(
        captain,
        order,
        ["accepted"],
        rebaseFailedMessage(base, rebase.message),
      );
      return;
    }
    const at = yield* nowIso;
    yield* note(
      captain,
      order,
      `rebase:${order.id}:${at}`,
      order.doneCheck === null ? `rebased onto ${base}` : `rebased onto ${base}, re-verifying`,
    );
    const verify = yield* checkOrder(captain, order, worktree);
    if (verify === undefined) return;
    if (verify.exit !== 0) {
      yield* failVerification(captain, order, verify, ["accepted"]);
      return;
    }
    yield* store.patchOrder({ orderId: order.id, from: ["accepted"], at: yield* nowIso, verify });
  });

  const rebaseOthers = Effect.fn("CaptainService.rebaseOthers")(function* (
    landed: CaptainOrder,
    projectId: ProjectId,
    base: string,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const staleBefore = isoAt(nowMs - CLAIM_TTL_MS);
    for (const captain of yield* store.listCaptains({ projectId })) {
      if (captain.status !== "active") continue;
      for (const order of yield* store.listOrders(captain.id)) {
        if (
          order.id === landed.id ||
          order.state !== "accepted" ||
          order.branch === null ||
          order.threadId === null
        ) {
          continue;
        }
        const claimed = yield* store.claimWork({
          orderId: order.id,
          state: "accepted",
          at: isoAt(nowMs),
          staleBefore,
        });
        if (!claimed) continue;
        yield* rebaseAccepted(captain, order, base).pipe(
          Effect.ensuring(
            nowIso.pipe(
              Effect.flatMap((at) =>
                store.patchOrder({
                  orderId: order.id,
                  from: ["accepted"],
                  at,
                  releaseClaim: true,
                }),
              ),
              Effect.ignore,
            ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.logWarning("rebasing an accepted order failed", {
                  orderId: order.id,
                  cause,
                }),
          ),
        );
      }
    }
  });

  const runMerge = Effect.fn("CaptainService.runMerge")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const projectCwd = yield* projectCwdOf(captain);
    const branch = order.branch;
    if (projectCwd === undefined || branch === null) {
      return yield* landFailed(captain, order, "merge", "The order has no branch to merge.");
    }
    const worktree = yield* crewWorktree(order);
    if (worktree === undefined) {
      return yield* landFailed(
        captain,
        order,
        "merge",
        "The crew worktree is gone, so the branch cannot be rebased.",
      );
    }
    const base = yield* landGit.baseBranch(projectCwd);
    if (base === undefined) {
      return yield* landFailed(captain, order, "merge", "The project has no base branch.");
    }
    const onBranch = yield* landGit.currentBranch(worktree);
    if (onBranch !== branch) {
      return yield* landFailed(
        captain,
        order,
        "merge",
        `The crew worktree is on ${onBranch ?? "a detached HEAD"}, not ${branch}.`,
      );
    }
    for (let attempt = 0; attempt < LAND_RETRY_LIMIT; attempt++) {
      const rebase = yield* landGit.rebaseOnto(worktree, base);
      if (rebase.kind === "conflict") {
        return yield* sendBackRebase(
          captain,
          order,
          ["landing"],
          rebaseConflictMessage(base, rebase.files),
        );
      }
      if (rebase.kind === "error") {
        return yield* landFailed(
          captain,
          order,
          "merge",
          `Rebase onto ${base} failed: ${rebase.message}`,
        );
      }
      if (rebase.kind === "rebased") {
        yield* note(
          captain,
          order,
          `rebase:${order.id}:${yield* nowIso}`,
          order.doneCheck === null ? `rebased onto ${base}` : `rebased onto ${base}, re-verifying`,
        );
      }
      const verify = yield* checkOrder(captain, order, worktree);
      if (verify !== undefined) {
        if (verify.exit !== 0) return yield* failVerification(captain, order, verify, ["landing"]);
        yield* store.patchOrder({
          orderId: order.id,
          from: ["landing"],
          at: yield* nowIso,
          verify,
        });
      }
      const branchSha = yield* landGit.revision(projectCwd, `refs/heads/${branch}`);
      if (branchSha === undefined) {
        return yield* landFailed(captain, order, "merge", `The branch ${branch} does not exist.`);
      }
      const moved = yield* landGit.fastForwardBase({ cwd: projectCwd, base, branchSha });
      if (moved.kind === "base_moved") continue;
      if (moved.kind === "error") {
        return yield* landFailed(captain, order, "merge", moved.message);
      }
      const line =
        moved.kind === "ref"
          ? `landed: merged ${branch} into ${base}; only the ref moved, because ${moved.reason}`
          : `landed: merged ${branch} into ${base}`;
      if (!(yield* landSucceeded(captain, order, "merge", line))) return false;
      yield* cleanupWorktree(captain, order, true);
      yield* rebaseOthers(order, captain.projectId, base);
      return true;
    }
    return yield* landFailed(
      captain,
      order,
      "merge",
      `${base} kept moving while the branch was being rebased. Try again.`,
    );
  });

  const openPullRequest = Effect.fn("CaptainService.openPullRequest")(function* (input: {
    readonly captain: Captain;
    readonly order: CaptainOrder;
    readonly cwd: string;
    readonly branch: string;
    readonly base: string;
  }) {
    const provider = yield* sourceControl.resolve({ cwd: input.cwd });
    const findOpen = () =>
      provider
        .listChangeRequests({
          cwd: input.cwd,
          headSelector: input.branch,
          state: "open",
          limit: 10,
        })
        .pipe(
          Effect.map((requests) =>
            requests.find((request) => request.headRefName === input.branch),
          ),
        );
    const existing = yield* findOpen();
    if (existing !== undefined) return existing.url;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "baton-pr-" });
        const bodyFile = path.join(directory, "body.md");
        yield* fileSystem.writeFileString(
          bodyFile,
          pullRequestBody({
            captainName: input.captain.name,
            orderId: input.order.id,
            brief: input.order.brief,
            summary: input.order.lastReport?.summary,
            reviewer: input.order.review?.model.model,
          }),
        );
        yield* provider.createChangeRequest({
          cwd: input.cwd,
          baseRefName: input.base,
          headSelector: input.branch,
          title: input.order.title,
          bodyFile,
        });
      }),
    );
    return (yield* findOpen())?.url;
  });

  const watchPullRequest = Effect.fn("CaptainService.watchPullRequest")(function* (
    order: CaptainOrder,
    url: string,
  ) {
    const link = sourceControlDefinitions.parseChangeRequestUrl(url)?.link;
    if (order.threadId === null || link === undefined) return;
    yield* dispatch(order.threadId, {
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`server:captain-pr-watch:${order.id}:${link.number}`),
      threadId: order.threadId,
      host: link.host,
      repository: link.repository,
      number: link.number,
      watching: true,
      link: { url, source: "created" },
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("watching a crew pull request failed", {
          orderId: order.id,
          cause: error,
        }),
      ),
    );
  });

  const runBranchLand = Effect.fn("CaptainService.runBranchLand")(function* (
    captain: Captain,
    order: CaptainOrder,
    openPr: boolean,
  ) {
    const action = openPr ? "pr" : "branch";
    const projectCwd = yield* projectCwdOf(captain);
    const branch = order.branch;
    if (projectCwd === undefined || branch === null) {
      return yield* landFailed(captain, order, action, "The order has no branch to push.");
    }
    const remote = yield* git.resolvePrimaryRemoteName(projectCwd).pipe(Effect.option);
    if (Option.isNone(remote)) {
      if (openPr) {
        return yield* landFailed(
          captain,
          order,
          action,
          "No git remote is configured, so no pull request can be opened.",
        );
      }
      return yield* landSucceeded(
        captain,
        order,
        "branch",
        `landed: kept ${branch} local, no remote`,
      );
    }
    const pushCwd = (yield* crewWorktree(order)) ?? projectCwd;
    const pushed = yield* landGit.pushBranch({ cwd: pushCwd, remote: remote.value, branch });
    if (pushed.kind === "error") {
      return yield* landFailed(captain, order, action, `Push failed: ${pushed.message}`);
    }
    if (!openPr) return yield* landSucceeded(captain, order, "branch", `landed: pushed ${branch}`);
    const base = (yield* landGit.baseBranch(projectCwd)) ?? "main";
    const opened = yield* openPullRequest({
      captain,
      order,
      cwd: projectCwd,
      branch,
      base,
    }).pipe(Effect.result);
    if (opened._tag === "Failure") {
      return yield* landFailed(
        captain,
        order,
        action,
        `Pull request failed: ${clipError(opened.failure.message)}`,
      );
    }
    const url = opened.success;
    if (url === undefined) {
      return yield* landFailed(
        captain,
        order,
        action,
        "Pull request failed: it was created but could not be found afterwards.",
      );
    }
    const landed = yield* landSucceeded(captain, order, "pr", `landed: PR ${url}`, url);
    if (landed) yield* watchPullRequest(order, url);
    return landed;
  });

  const runLand = Effect.fn("CaptainService.runLand")(function* (
    captain: Captain,
    claimed: CaptainOrder,
  ) {
    yield* projectLock(captain.projectId)
      .withPermits(1)(
        Effect.gen(function* () {
          const found = yield* store.getOrder(claimed.id);
          if (Option.isNone(found) || found.value.state !== "landing") return;
          const order = found.value;
          yield* note(captain, order, `land:${order.id}:${order.updatedAt}:landing`, "landing");
          if (order.delivery === "merge") {
            yield* runMerge(captain, order);
          } else if (order.delivery === "none") {
            yield* store.patchOrder({
              orderId: order.id,
              from: ["landing"],
              at: yield* nowIso,
              state: "accepted",
            });
          } else {
            yield* runBranchLand(captain, order, order.delivery === "pr");
          }
        }),
      )
      .pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("landing an order failed", { orderId: claimed.id, cause }).pipe(
              Effect.andThen(
                landFailed(
                  captain,
                  claimed,
                  claimed.delivery === "none" ? "branch" : claimed.delivery,
                  clipError(Cause.pretty(cause)).slice(0, 300),
                ),
              ),
            ),
        ),
      );
    yield* kick;
  });

  const beginLanding = Effect.fn("CaptainService.beginLanding")(function* (
    order: CaptainOrder,
    delivery: CaptainOrderDelivery,
    from: ReadonlyArray<CaptainOrder["state"]>,
  ) {
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from,
      at: yield* nowIso,
      state: "landing",
      delivery,
      land: null,
    });
    if (moved) yield* due.invalidate;
    return moved;
  });

  const openMergeApproval = Effect.fn("CaptainService.openMergeApproval")(function* (
    captain: Captain,
    order: CaptainOrder,
    wake: boolean,
  ) {
    const projectCwd = yield* projectCwdOf(captain);
    const base = projectCwd === undefined ? undefined : yield* landGit.baseBranch(projectCwd);
    const target = base ?? "the base branch";
    return yield* openEscalation({
      captainId: captain.id,
      orderId: order.id,
      kind: "approval",
      summary: `Merge ${order.title} into ${target}?`,
      detail: `Branch ${order.branch ?? "(none)"}. ${
        order.review === null
          ? "It was not reviewed."
          : `Reviewed by ${order.review.model.model}: ${order.review.verdict}.`
      } Merging rebases the branch onto ${target}, re-runs the done-check, then fast-forwards ${target}.`,
      options: ["merge", "hold"],
      requestId: mergeApprovalKey(order),
      wake,
    });
  });

  const ensureMergeApproval = Effect.fn("CaptainService.ensureMergeApproval")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const key = mergeApprovalKey(order);
    const known = yield* store.listEscalations({ captainId: captain.id });
    if (known.some((escalation) => escalation.requestId === key)) return;
    yield* openMergeApproval(captain, order, true);
  });

  const withdrawMergeApprovals = Effect.fn("CaptainService.withdrawMergeApprovals")(function* (
    order: CaptainOrder,
    resolution: string,
  ) {
    const open = yield* store.listEscalations({ captainId: order.captainId, status: "open" });
    const at = yield* nowIso;
    for (const escalation of open) {
      if (escalation.orderId === order.id && isMergeApproval(escalation)) {
        yield* store.resolveEscalation({ id: escalation.id, resolution, at });
      }
    }
  });

  const trackWork = Effect.fn("CaptainService.trackWork")(function* <E>(
    orderId: CaptainOrderId,
    work: Effect.Effect<void, E>,
  ) {
    const fiber = yield* work.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("captain order work failed", { orderId, cause }),
      ),
      Effect.ensuring(Effect.sync(() => workFibers.delete(orderId))),
      Effect.forkIn(scope),
    );
    workFibers.set(orderId, fiber);
  });

  const cancelWork = (orderId: CaptainOrderId) =>
    Effect.suspend(() => {
      const fiber = workFibers.get(orderId);
      workFibers.delete(orderId);
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

  const agentsMdOf = (cwd: string) =>
    fileSystem
      .readFileString(path.join(cwd, "AGENTS.md"))
      .pipe(Effect.orElseSucceed(() => undefined));

  const diffOf = Effect.fn("CaptainService.diffOf")(function* (
    cwd: string,
    baseRef: string,
    branch: string,
  ) {
    const range = `${baseRef}...${branch}`;
    const full = yield* git
      .execute({
        operation: "CaptainService.reviewDiff",
        cwd,
        args: ["diff", "--no-color", range],
        maxOutputBytes: REVIEW_DIFF_MAX_BYTES,
        appendTruncationMarker: true,
        allowNonZeroExit: true,
      })
      .pipe(Effect.result);
    if (full._tag === "Failure") return { unreadable: full.failure.message };
    if (full.success.exitCode !== 0) {
      return { unreadable: full.success.stderr.trim().slice(0, 300) || "git diff failed" };
    }
    if (!full.success.stdoutTruncated) {
      return { text: full.success.stdout.length === 0 ? "(no changes)" : full.success.stdout };
    }
    const files = yield* git
      .execute({
        operation: "CaptainService.reviewFiles",
        cwd,
        args: ["diff", "--no-color", "--name-status", range],
        allowNonZeroExit: true,
      })
      .pipe(Effect.option);
    return { files: Option.isSome(files) ? files.value.stdout : "(could not list the files)" };
  });

  const launchReviewer = Effect.fn("CaptainService.launchReviewer")(function* (
    captain: Captain,
    order: CaptainOrder,
  ) {
    const previous = order.review;
    const nextRound = previous === null || previous.finishedAt !== null;
    const round = previous === null ? 1 : nextRound ? previous.round + 1 : previous.round;
    const crewShell = order.threadId === null ? null : yield* getShell(order.threadId);
    const cwd = yield* crewCwd(captain, order);
    if (
      crewShell === null ||
      cwd === undefined ||
      order.baseRef === null ||
      order.branch === null
    ) {
      yield* openEscalation({
        captainId: captain.id,
        orderId: order.id,
        kind: "decision",
        summary: `${order.title}: no worktree to review`,
        detail: "The crew thread or its worktree is gone, so no reviewer could be started.",
        options: ["order_retry", "order_drop"],
        wake: true,
      });
      return;
    }
    const threadId = ThreadId.make(`captain-review:${order.id}:${round}`);
    let review: CaptainReview;
    if (previous !== null && !nextRound) {
      review = previous;
      const alive = yield* getShell(review.threadId);
      if (alive !== null) {
        yield* reviewerRole(captain, order, review.threadId);
        return;
      }
    } else {
      const providers = yield* providerRegistry.getProviders;
      const crewDriver = providers.find(
        (provider) => provider.instanceId === crewShell.modelSelection.instanceId,
      )?.driver;
      const choice = pickReviewer({
        crew: crewShell.modelSelection,
        crewDriver: crewDriver ?? ("" as never),
        configured: captain.charter.reviewModel,
        providers,
      });
      const at = yield* nowIso;
      review = {
        round,
        threadId,
        model: choice.model,
        sameProvider: choice.sameProvider,
        verdict: null,
        findings: [],
        previousFindings: previous?.findings ?? [],
        reprompted: false,
        startedAt: at,
        finishedAt: null,
      };
      const written = yield* store.patchOrder({
        orderId: order.id,
        from: ["reviewing"],
        at,
        review,
      });
      if (!written) return;
    }
    const [diff, agentsMd] = yield* Effect.all([
      diffOf(cwd, order.baseRef, order.branch),
      agentsMdOf(cwd),
    ]);
    yield* reviewerRole(captain, order, review.threadId);
    const text = reviewerBrief({
      captainName: captain.name,
      orderId: order.id,
      title: order.title,
      brief: order.brief,
      round: review.round,
      baseRef: order.baseRef,
      branch: order.branch,
      worktreePath: cwd,
      diff,
      agentsMd,
      previousFindings: review.previousFindings,
    });
    yield* launches
      .launch({
        commandId: CommandId.make(`captain-review:${order.id}:${review.round}:launch`),
        threadId: review.threadId,
        projectId: captain.projectId,
        title: `Review: ${order.title}`,
        modelSelection: review.model,
        runtimeMode: crewShell.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "existing_worktree", worktreePath: cwd, branch: order.branch },
        initialMessage: {
          messageId: MessageId.make(`captain-review:${order.id}:${review.round}:brief`),
          senderThreadId: captain.threadId,
          text,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "server",
        groupedUnderThreadId: order.threadId ?? captain.threadId,
      })
      .pipe(
        Effect.tapError(() => clearRole(review.threadId)),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("captain reviewer launch failed", { orderId: order.id, cause }).pipe(
              Effect.andThen(clearRole(review.threadId)),
              Effect.andThen(
                openEscalation({
                  captainId: captain.id,
                  orderId: order.id,
                  kind: "decision",
                  summary: `${order.title}: the reviewer could not be started`,
                  detail: "Retry or drop the order. A server restart also tries the review again.",
                  options: ["order_retry", "order_drop"],
                  wake: true,
                }),
              ),
            ),
        ),
      );
  });

  const processGates = Effect.fn("CaptainService.processGates")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const staleBefore = isoAt(nowMs - CLAIM_TTL_MS);
    const at = isoAt(nowMs);
    const claim = (order: CaptainOrder) =>
      store.claimWork({ orderId: order.id, state: order.state, at, staleBefore });
    const captainOf = (order: CaptainOrder) =>
      store
        .getCaptain(order.captainId)
        .pipe(Effect.map(Option.filter((c) => c.status === "active")));
    for (const order of yield* store.listUnclaimed({ state: "verifying", staleBefore })) {
      const captain = yield* captainOf(order);
      if (Option.isNone(captain) || !(yield* claim(order))) continue;
      yield* trackWork(order.id, runVerification(captain.value, order));
    }
    for (const order of yield* store.listUnclaimed({ state: "reviewing", staleBefore })) {
      const captain = yield* captainOf(order);
      if (Option.isNone(captain) || !(yield* claim(order))) continue;
      yield* trackWork(order.id, launchReviewer(captain.value, order));
    }
    for (const order of yield* store.listUnclaimed({ state: "accepted", staleBefore })) {
      const captain = yield* captainOf(order);
      if (Option.isNone(captain)) continue;
      if (order.delivery === "branch" || order.delivery === "pr") {
        yield* beginLanding(order, order.delivery, ["accepted"]);
      } else if (order.delivery === "merge") {
        yield* ensureMergeApproval(captain.value, order);
      }
    }
    for (const order of yield* store.listUnclaimed({ state: "landing", staleBefore })) {
      const captain = yield* captainOf(order);
      if (Option.isNone(captain) || !(yield* claim(order))) continue;
      yield* trackWork(order.id, runLand(captain.value, order));
    }
    for (const order of yield* store.listUnclaimed({ state: "verify_failed", staleBefore })) {
      const captain = yield* captainOf(order);
      if (Option.isNone(captain)) continue;
      if (order.pendingFollowUp === null) {
        if (order.retries > captain.value.charter.retryLimit) {
          yield* retryLimitEscalation(
            captain.value,
            order,
            "out of retries",
            order.verify === null
              ? "A reviewer rejected the change."
              : verifyFailureDetail(order.verify),
          );
        }
        continue;
      }
      if (!(yield* claim(order))) continue;
      yield* trackWork(
        order.id,
        settleFailedGate(captain.value, order, "sent back after a failed check").pipe(
          Effect.ensuring(
            store
              .patchOrder({
                orderId: order.id,
                from: ["verify_failed"],
                at,
                releaseClaim: true,
              })
              .pipe(Effect.ignore),
          ),
        ),
      );
    }
  });

  const processStalls = Effect.fn("CaptainService.processStalls")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    let nextDueMs = NEVER_DUE_MS;
    const captains = new Map<CaptainId, Captain>();
    for (const order of yield* store.listInState("running")) {
      let captain = captains.get(order.captainId);
      if (captain === undefined) {
        const found = yield* store.getCaptain(order.captainId);
        if (Option.isNone(found)) continue;
        captain = found.value;
        captains.set(captain.id, captain);
      }
      if (captain.status !== "active") continue;
      const stallMs = captain.charter.stallMinutes * 60_000;
      const idleMs = nowMs - Date.parse(order.lastActivityAt);
      const shell = order.threadId === null ? null : yield* getShell(order.threadId);
      const held = shell !== null && holdsStall(shell);
      const level = held ? 0 : stallLevelFor(idleMs, stallMs);
      if (level !== order.stallLevel) {
        const moved = yield* store.patchOrder({
          orderId: order.id,
          from: ["running"],
          at: isoAt(nowMs),
          stallLevel: level,
        });
        if (moved && level === 1) {
          yield* note(
            captain,
            order,
            `stall:${order.id}:${order.lastActivityAt}:1`,
            `stalled for ${captain.charter.stallMinutes}m`,
          );
        }
        if (moved && level === 2) {
          yield* openEscalation({
            captainId: captain.id,
            orderId: order.id,
            kind: "stall",
            summary: `${order.title}: no activity for ${2 * captain.charter.stallMinutes}m`,
            detail: "The crew has done nothing for two stall windows in a row.",
            options: ["order_send a nudge", "order_retry", "order_drop"],
            wake: true,
          });
        }
      }
      const lastActivityMs = Date.parse(order.lastActivityAt);
      nextDueMs = Math.min(
        nextDueMs,
        level === 2 && !held ? nowMs + STALL_RECHECK_MS : lastActivityMs + (level + 1) * stallMs,
        ...(level > 0 || held ? [nowMs + STALL_RECHECK_MS] : []),
      );
    }
    return Math.max(nextDueMs, nowMs + 1_000);
  });

  const pass = permit.withPermits(1)(
    Effect.gen(function* () {
      const captains = yield* store.listCaptains({});
      for (const captain of captains) {
        yield* admitCaptain(captain).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("captain admission failed", { captainId: captain.id, cause }),
          ),
        );
      }
      yield* processGates();
      return yield* processStalls();
    }),
  );

  const processDue = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (yield* due.isIdle(nowMs)) return;
    const version = yield* due.version;
    const nextDueMs = yield* pass;
    yield* due.record(version, nextDueMs, nowMs);
  });

  const kick: Effect.Effect<void> = Effect.gen(function* () {
    yield* due.invalidate;
    const token = Symbol("captain-kick");
    const fiber = yield* processDue.pipe(
      Effect.catchCause((cause) => Effect.logWarning("captain pass failed", { cause })),
      Effect.ensuring(Effect.sync(() => kicked.delete(token))),
      Effect.forkIn(scope),
    );
    kicked.set(token, fiber);
  });

  const drain: CaptainService["Service"]["drain"] = Effect.gen(function* () {
    for (;;) {
      yield* pass;
      const pending = [...new Set([...kicked.values(), ...workFibers.values()])];
      if (pending.length === 0) return;
      yield* Effect.forEach(pending, Fiber.await, { discard: true });
      for (const [key, fiber] of kicked) if (pending.includes(fiber)) kicked.delete(key);
      for (const [key, fiber] of workFibers) if (pending.includes(fiber)) workFibers.delete(key);
    }
  });

  const create: CaptainService["Service"]["create"] = Effect.fn("CaptainService.create")(
    function* (input) {
      const shell = yield* getShell(input.threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
        return yield* new CaptainError({ reason: "thread_not_found", threadId: input.threadId });
      }
      if (shell.lineage.relationshipToParent === "subagent") {
        return yield* new CaptainError({ reason: "thread_is_subagent", threadId: input.threadId });
      }
      const current = yield* threadRoles.get(input.threadId);
      if (current?.role === "crew" || current?.role === "reviewer") {
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
      yield* assignRole(
        captain.threadId,
        { role: "captain", captainId: captain.id },
        T3_CODE_CAPTAIN_ROLE_INSTRUCTIONS,
      );
      yield* due.invalidate;
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
      yield* clearRole(found.value.threadId);
      yield* due.invalidate;
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
      verify: null,
      review: null,
      land: null,
      prUrl: null,
      pendingFollowUp: null,
      stallLevel: 0,
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    yield* store.insertOrder(created);
    yield* due.invalidate;
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

  const sendToCrewThread = Effect.fn("CaptainService.sendToCrewThread")(function* (
    captain: Captain,
    order: CaptainOrder,
    text: string,
    mode: ThreadManagementService.ThreadManagementSendMode,
  ) {
    const crewThreadId = order.threadId as ThreadId;
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

  const requireRunningCrew = (captain: Captain, order: CaptainOrder) =>
    order.state !== "running" || order.threadId === null
      ? Effect.fail(
          new CaptainError({
            reason: "crew_not_running",
            captainId: captain.id,
            orderId: order.id,
          }),
        )
      : Effect.void;

  const sendToOrder: CaptainService["Service"]["sendToOrder"] = Effect.fn(
    "CaptainService.sendToOrder",
  )(function* ({ captain, orderId, text, mode }) {
    const order = yield* ownedOrder(captain, orderId);
    yield* requireRunningCrew(captain, order);
    return yield* sendToCrewThread(captain, order, text, mode);
  });

  const answerOrder: CaptainService["Service"]["answerOrder"] = Effect.fn(
    "CaptainService.answerOrder",
  )(function* ({ captain, orderId, text }) {
    const order = yield* ownedOrder(captain, orderId);
    yield* requireRunningCrew(captain, order);
    const crewThreadId = order.threadId as ThreadId;
    const pending = yield* threads
      .getThreadRecords(crewThreadId, ["turnItems"], { turnItemTypes: ["user_input_request"] })
      .pipe(
        Effect.map(({ turnItems }) =>
          turnItems.findLast(
            (item) => item.type === "user_input_request" && item.status === "pending",
          ),
        ),
        Effect.orElseSucceed(() => undefined),
      );
    let delivery: "started" | "queued" | "steered" | "restarted";
    if (pending?.type === "user_input_request") {
      yield* dispatch(crewThreadId, {
        type: "runtime-request.respond",
        commandId: CommandId.make(`mcp:captain-answer:${yield* newId}`),
        threadId: crewThreadId,
        requestId: pending.requestId,
        answers: Object.fromEntries(pending.questions.map((question) => [question.id, text])),
      });
      delivery = "steered";
    } else {
      delivery = (yield* sendToCrewThread(captain, order, text, "queue")).delivery;
    }
    const resolved = yield* store.resolveOrderEscalations({
      orderId,
      kind: "decision",
      resolution: text,
      at: yield* nowIso,
    });
    return { delivery, resolved: resolved.length };
  });

  const retryOrder: CaptainService["Service"]["retryOrder"] = Effect.fn(
    "CaptainService.retryOrder",
  )(function* ({ captain, orderId, brief }) {
    const order = yield* ownedOrder(captain, orderId);
    if (
      !RETRY_STATES.includes(order.state as (typeof RETRY_STATES)[number]) ||
      order.threadId === null
    ) {
      return yield* new CaptainError({
        reason: "invalid_state",
        captainId: captain.id,
        orderId,
        detail: `It is ${order.state}; only an order with a crew at work, under check, under review, accepted or failed to land can be retried.`,
      });
    }
    const crewThreadId = order.threadId;
    const at = yield* nowIso;
    const retries = order.retries + 1;
    const moved = yield* store.patchOrder({
      orderId,
      from: RETRY_STATES,
      at,
      state: "running",
      retries,
      pendingFollowUp: null,
      stallLevel: 0,
      land: null,
    });
    if (!moved) {
      return yield* new CaptainError({ reason: "invalid_state", captainId: captain.id, orderId });
    }
    yield* store.touchActivity({ orderId, at });
    yield* cancelWork(orderId);
    yield* withdrawMergeApprovals(order, "withdrawn: the order was retried");
    if (order.review !== null && order.review.finishedAt === null) {
      yield* clearRole(order.review.threadId);
      yield* threads
        .interruptThread({
          projectId: captain.projectId,
          commandId: CommandId.make(`mcp:captain-retry-review:${yield* newId}`),
          threadId: order.review.threadId,
          reason: "The order was retried.",
        })
        .pipe(Effect.ignore);
    }
    yield* threads
      .interruptThread({
        projectId: captain.projectId,
        commandId: CommandId.make(`mcp:captain-retry:${yield* newId}`),
        threadId: crewThreadId,
        reason: "The captain retried the order.",
      })
      .pipe(Effect.ignore);
    yield* sendToCrewThread(
      captain,
      order,
      `The captain is retrying this order. Your earlier work is still in the worktree. Start from this brief:\n${brief ?? order.brief}`,
      "queue",
    );
    yield* due.invalidate;
    return {
      ...order,
      state: "running",
      retries,
      pendingFollowUp: null,
      land: null,
      updatedAt: at,
    };
  });

  const dropOrder: CaptainService["Service"]["dropOrder"] = Effect.fn("CaptainService.dropOrder")(
    function* ({ captain, orderId, reason }) {
      const order = yield* ownedOrder(captain, orderId);
      if (order.state === "dropped") return order;
      if (!DROP_STATES.includes(order.state as (typeof DROP_STATES)[number])) {
        return yield* new CaptainError({
          reason: "invalid_order",
          captainId: captain.id,
          orderId,
          detail:
            order.state === "landing"
              ? "It is landing right now. Wait for it to land or fail."
              : "A finished or landed order cannot be dropped.",
        });
      }
      const at = yield* nowIso;
      const dropped = yield* store.transitionOrder({
        orderId,
        from: DROP_STATES,
        to: "dropped",
        at,
      });
      if (!dropped) {
        return yield* new CaptainError({ reason: "invalid_state", captainId: captain.id, orderId });
      }
      yield* cancelWork(orderId);
      yield* withdrawMergeApprovals(order, "withdrawn: the order was dropped");
      if (order.review !== null && order.review.finishedAt === null) {
        yield* clearRole(order.review.threadId);
        yield* stopThread(captain, order, order.review.threadId, reason, true);
      }
      if (order.threadId !== null) {
        yield* clearRole(order.threadId);
        yield* stopThread(captain, order, order.threadId, reason, true);
        yield* cleanupWorktree(captain, order, false);
      }
      yield* due.invalidate;
      yield* admitNow(captain);
      return { ...order, state: "dropped", updatedAt: at } satisfies CaptainOrder;
    },
  );

  const landOrder: CaptainService["Service"]["landOrder"] = Effect.fn("CaptainService.landOrder")(
    function* ({ captain, orderId, delivery, approved }) {
      if (captain.status !== "active") {
        return yield* new CaptainError({
          reason: "captain_not_active",
          captainId: captain.id,
          threadId: captain.threadId,
        });
      }
      const order = yield* ownedOrder(captain, orderId);
      if (order.state !== "accepted" && order.state !== "land_failed") {
        return yield* new CaptainError({
          reason: "invalid_state",
          captainId: captain.id,
          orderId,
          detail: `It is ${order.state}; only an accepted order, or one that failed to land, can be landed.`,
        });
      }
      const effective = delivery ?? order.delivery;
      const from = [order.state] as const;
      if (effective === "none") {
        yield* store.patchOrder({
          orderId,
          from,
          at: yield* nowIso,
          state: "accepted",
          delivery: "none",
          land: null,
        });
        return {
          order: { ...order, state: "accepted", delivery: "none", land: null },
          needsApproval: false,
        };
      }
      if (effective === "merge" && !approved) {
        if (order.delivery !== "merge") {
          yield* store.patchOrder({ orderId, from, at: yield* nowIso, delivery: "merge" });
        }
        yield* openMergeApproval(captain, { ...order, delivery: "merge" }, false);
        return { order: { ...order, delivery: "merge" }, needsApproval: true };
      }
      const moved = yield* beginLanding(order, effective, from);
      if (!moved) {
        return yield* new CaptainError({ reason: "invalid_state", captainId: captain.id, orderId });
      }
      if (approved) yield* withdrawMergeApprovals(order, "merge");
      yield* kick;
      return {
        order: { ...order, state: "landing", delivery: effective, land: null },
        needsApproval: false,
      };
    },
  );

  const listOrdersOf: CaptainService["Service"]["listOrdersOf"] = Effect.fn(
    "CaptainService.listOrdersOf",
  )(function* (captainId) {
    const found = yield* store.getCaptain(captainId);
    if (Option.isNone(found))
      return yield* new CaptainError({ reason: "captain_not_found", captainId });
    return yield* store.listOrders(captainId);
  });

  const captainOfOrder = Effect.fn("CaptainService.captainOfOrder")(function* (
    orderId: CaptainOrderId,
  ) {
    const order = yield* store.getOrder(orderId);
    if (Option.isNone(order))
      return yield* new CaptainError({ reason: "order_not_found", orderId });
    const captain = yield* store.getCaptain(order.value.captainId);
    if (Option.isNone(captain) || captain.value.status === "released") {
      return yield* new CaptainError({
        reason: "captain_not_found",
        captainId: order.value.captainId,
        orderId,
      });
    }
    return captain.value;
  });

  const landOrderById: CaptainService["Service"]["landOrderById"] = Effect.fn(
    "CaptainService.landOrderById",
  )(function* ({ orderId, delivery }) {
    const captain = yield* captainOfOrder(orderId);
    const { order } = yield* landOrder({ captain, orderId, delivery, approved: true });
    return order;
  });

  const retryOrderById: CaptainService["Service"]["retryOrderById"] = Effect.fn(
    "CaptainService.retryOrderById",
  )(function* ({ orderId, brief }) {
    const captain = yield* captainOfOrder(orderId);
    return yield* retryOrder({ captain, orderId, brief });
  });

  const dropOrderById: CaptainService["Service"]["dropOrderById"] = Effect.fn(
    "CaptainService.dropOrderById",
  )(function* ({ orderId, reason }) {
    const captain = yield* captainOfOrder(orderId);
    return yield* dropOrder({ captain, orderId, reason: reason ?? "Dropped by the user." });
  });

  const mergeCharter = Effect.fn("CaptainService.mergeCharter")(function* (
    captain: Captain,
    patch: CaptainCharterPatch,
  ) {
    const invalid = (detail: string) =>
      new CaptainError({ reason: "invalid_charter", captainId: captain.id, detail });
    const merged: Record<string, unknown> = { ...captain.charter };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    const charter = yield* decodeCharter(merged).pipe(
      Effect.mapError((error) => invalid(clipError(error.message))),
    );
    const captainShell = yield* getShell(captain.threadId);
    if (
      captainShell !== null &&
      runtimeModeRank(charter.crewRuntimeMode) > runtimeModeRank(captainShell.runtimeMode)
    ) {
      return yield* invalid(
        `Crew would run at ${charter.crewRuntimeMode}, above this captain's ${captainShell.runtimeMode}.`,
      );
    }
    const providers = yield* providerRegistry.getProviders;
    for (const key of ["reviewModel", "defaultModel"] as const) {
      const model = charter[key];
      if (
        model !== undefined &&
        !providers.some((entry) => entry.instanceId === model.instanceId && entry.enabled)
      ) {
        return yield* invalid(`${key} names a provider instance that is not available.`);
      }
    }
    return charter;
  });

  const update: CaptainService["Service"]["update"] = Effect.fn("CaptainService.update")(
    function* (input) {
      const found = yield* store.getCaptain(input.captainId);
      if (Option.isNone(found)) {
        return yield* new CaptainError({ reason: "captain_not_found", captainId: input.captainId });
      }
      let captain = found.value;
      if (captain.status === "released") {
        return yield* new CaptainError({
          reason: "invalid_state",
          captainId: captain.id,
          detail: "A released captain cannot be updated. Make the thread a captain again.",
        });
      }
      if (input.charter !== undefined) {
        const charter = yield* mergeCharter(captain, input.charter);
        const at = yield* nowIso;
        yield* store.setCaptainCharter({ captainId: captain.id, charter, at });
        captain = { ...captain, charter, updatedAt: at };
      }
      if (input.status !== undefined && input.status !== captain.status) {
        const at = yield* nowIso;
        yield* store.setCaptainStatus({ captainId: captain.id, status: input.status, at });
        captain = { ...captain, status: input.status, updatedAt: at };
        if (input.status === "paused") {
          yield* dispatch(captain.threadId, {
            type: "queue.hold",
            commandId: CommandId.make(`server:captain-pause:${yield* newId}`),
            threadId: captain.threadId,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("holding a paused captain's queue failed", {
                captainId: captain.id,
                cause: error,
              }),
            ),
          );
          for (const order of yield* store.listOrders(captain.id)) {
            if (order.state === "running" && order.threadId !== null) {
              yield* threads
                .interruptThread({
                  projectId: captain.projectId,
                  commandId: CommandId.make(`server:captain-pause-stop:${yield* newId}`),
                  threadId: order.threadId,
                  reason: "The captain was paused.",
                })
                .pipe(Effect.ignore);
            }
          }
        } else {
          yield* dispatch(captain.threadId, {
            type: "queue.resume",
            commandId: CommandId.make(`server:captain-resume:${yield* newId}`),
            threadId: captain.threadId,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("resuming a captain's queue failed", {
                captainId: captain.id,
                cause: error,
              }),
            ),
          );
          for (const order of yield* store.listOrders(captain.id)) {
            if (order.state !== "running" || order.threadId === null) continue;
            const shell = yield* getShell(order.threadId);
            if (shell !== null && shell.activeRunId === null) {
              yield* sendFollowUp(captain, order, RESUME_NUDGE, `resume:${order.id}:${at}`).pipe(
                Effect.ignore,
              );
            }
          }
        }
      }
      yield* due.invalidate;
      if (captain.status === "active") yield* admitNow(captain);
      return captain;
    },
  );

  const crewReport: CaptainService["Service"]["crewReport"] = Effect.fn(
    "CaptainService.crewReport",
  )(function* ({ threadId, report }) {
    const { captain, order } = yield* requireCrew(threadId);
    const at = yield* nowIso;
    const target =
      report.status === "done" && order.state === "running"
        ? order.doneCheck !== null
          ? "verifying"
          : order.kind === "change"
            ? "reviewing"
            : "done"
        : undefined;
    const lastReport = {
      status: report.status,
      summary: report.summary,
      asks: report.asks ?? [],
      at,
    };
    const state = yield* store.recordReport({
      orderId: order.id,
      report: lastReport,
      reportMd: report.reportMd,
      at,
      ...(target === undefined ? {} : { moveTo: { from: ["running" as const], to: target } }),
    });
    const moved = target !== undefined && state === target;
    yield* due.invalidate;
    yield* PubSub.publish(signals, {
      kind: "report",
      captainId: captain.id,
      order: { ...order, state, lastReport },
      key: `report:${order.id}:${at}`,
      status: report.status,
      summary: report.summary,
      asks: lastReport.asks,
    });
    if (moved && state === "done") yield* admitNow(captain);
    if (moved && state !== "done") yield* kick;
    return {
      ...order,
      state,
      lastReport,
      reportMd: report.reportMd ?? order.reportMd,
      updatedAt: at,
    } satisfies CaptainOrder;
  });

  const modelLabel = (review: CaptainReview) => review.model.model;

  const submitReview: CaptainService["Service"]["submitReview"] = Effect.fn(
    "CaptainService.submitReview",
  )(function* ({ threadId, review: submitted }) {
    const { captain, order } = yield* requireReviewer(threadId);
    const active = order.review as CaptainReview;
    const at = yield* nowIso;
    const finished: CaptainReview = {
      ...active,
      verdict: submitted.verdict,
      findings: submitted.findings,
      finishedAt: at,
    };
    if (submitted.verdict === "approve") {
      const moved = yield* store.patchOrder({
        orderId: order.id,
        from: ["reviewing"],
        at,
        state: "accepted",
        review: finished,
      });
      if (moved) {
        yield* clearRole(threadId);
        yield* note(
          captain,
          order,
          `review:${order.id}:${active.round}:approve`,
          `accepted (reviewed by ${modelLabel(active)})`,
        );
        yield* admitNow(captain);
      }
      return { ...order, state: "accepted", review: finished, updatedAt: at };
    }
    const retries = order.retries + 1;
    const exhausted = retries > captain.charter.retryLimit;
    const followUp = reviewRejectedMessage(modelLabel(active), submitted.findings);
    const moved = yield* store.patchOrder({
      orderId: order.id,
      from: ["reviewing"],
      at,
      state: "verify_failed",
      retries,
      review: finished,
      pendingFollowUp: exhausted ? null : followUp,
    });
    if (!moved) return order;
    yield* clearRole(threadId);
    const rejected = { ...order, retries, review: finished, pendingFollowUp: followUp };
    if (exhausted) {
      yield* note(
        captain,
        order,
        `review:${order.id}:${active.round}:limit`,
        `review rejected ${times(retries)}, needs you`,
      );
      yield* retryLimitEscalation(
        captain,
        order,
        `review rejected ${times(retries)}`,
        `Findings from ${modelLabel(active)}:\n${followUp}`,
      );
      return { ...rejected, state: "verify_failed", pendingFollowUp: null };
    }
    const count = submitted.findings.length;
    yield* settleFailedGate(
      captain,
      rejected,
      `review rejected (${count} finding${count === 1 ? "" : "s"}), sent back`,
    );
    return { ...rejected, state: "running", pendingFollowUp: null };
  });

  const reviewerEnded: CaptainService["Service"]["reviewerEnded"] = Effect.fn(
    "CaptainService.reviewerEnded",
  )(function* (threadId) {
    const found = yield* requireReviewer(threadId).pipe(Effect.option);
    if (Option.isNone(found)) return;
    const { captain, order } = found.value;
    const review = order.review as CaptainReview;
    if (!review.reprompted) {
      const marked = yield* store.patchOrder({
        orderId: order.id,
        from: ["reviewing"],
        at: yield* nowIso,
        review: { ...review, reprompted: true },
      });
      if (!marked) return;
      yield* threads
        .sendToThread({
          projectId: captain.projectId,
          commandId: CommandId.make(`server:captain-review-reprompt:${order.id}:${review.round}`),
          threadId,
          messageId: MessageId.make(`message:captain-review-reprompt:${order.id}:${review.round}`),
          senderThreadId: captain.threadId,
          text: REVIEW_REPROMPT,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.mapError(threadFailure(threadId)));
      return;
    }
    yield* openEscalation({
      captainId: captain.id,
      orderId: order.id,
      kind: "decision",
      summary: `${order.title}: the reviewer finished without a verdict`,
      detail: `${modelLabel(review)} was asked twice and never called review_submit.`,
      options: ["order_retry", "order_drop", "accept the change yourself"],
      wake: true,
    });
  });

  const escalate: CaptainService["Service"]["escalate"] = Effect.fn("CaptainService.escalate")(
    function* ({ captain, orderId, kind, summary, detail, options }) {
      if (orderId !== undefined) yield* ownedOrder(captain, orderId);
      return yield* openEscalation({
        captainId: captain.id,
        orderId: orderId ?? null,
        kind,
        summary,
        detail: detail ?? "",
        options: options ?? [],
        wake: false,
      });
    },
  );

  const listEscalations: CaptainService["Service"]["listEscalations"] = (input) =>
    store.listEscalations(input);

  const resolveEscalation: CaptainService["Service"]["resolveEscalation"] = Effect.fn(
    "CaptainService.resolveEscalation",
  )(function* ({ escalationId, resolution }) {
    const found = yield* store.getEscalation(escalationId);
    if (Option.isNone(found)) return yield* new CaptainError({ reason: "escalation_not_found" });
    const escalation = found.value;
    if (escalation.status !== "open") {
      return yield* new CaptainError({
        reason: "invalid_state",
        captainId: escalation.captainId,
        detail: "It is already resolved.",
      });
    }
    if (isMergeApproval(escalation) && mergeDecision(resolution) === undefined) {
      return yield* new CaptainError({
        reason: "invalid_state",
        captainId: escalation.captainId,
        detail: "Resolve a merge approval with merge or hold.",
      });
    }
    if (
      escalation.kind === "approval" &&
      escalation.requestId !== null &&
      !isMergeApproval(escalation)
    ) {
      const decision = approvalDecision(resolution);
      if (decision === undefined) {
        return yield* new CaptainError({
          reason: "invalid_state",
          captainId: escalation.captainId,
          detail: "Resolve an approval with approve or deny.",
        });
      }
      const order =
        escalation.orderId === null ? Option.none() : yield* store.getOrder(escalation.orderId);
      if (Option.isSome(order) && order.value.threadId !== null) {
        yield* dispatch(order.value.threadId, {
          type: "runtime-request.respond",
          commandId: CommandId.make(`server:captain-approval:${escalation.id}`),
          threadId: order.value.threadId,
          requestId: escalation.requestId,
          decision,
        });
      }
    }
    const at = yield* nowIso;
    const resolved = yield* store.resolveEscalation({ id: escalation.id, resolution, at });
    const settled: CaptainEscalation = {
      ...escalation,
      status: "resolved",
      resolution,
      resolvedAt: at,
    };
    if (resolved) {
      const captain = yield* store.getCaptain(escalation.captainId);
      const order =
        escalation.orderId === null ? Option.none() : yield* store.getOrder(escalation.orderId);
      if (Option.isSome(captain)) {
        yield* note(
          captain.value,
          Option.getOrNull(order),
          `resolved:${escalation.id}`,
          `you resolved: ${escalation.summary} → ${resolution}`,
        );
        if (
          isMergeApproval(escalation) &&
          mergeDecision(resolution) === "merge" &&
          Option.isSome(order) &&
          (order.value.state === "accepted" || order.value.state === "land_failed")
        ) {
          if (yield* beginLanding(order.value, "merge", [order.value.state])) yield* kick;
        }
      }
    }
    return settled;
  });

  const touchActivity: CaptainService["Service"]["touchActivity"] = (orderId) =>
    nowIso.pipe(Effect.flatMap((at) => store.touchActivity({ orderId, at })));

  const roleOf: CaptainService["Service"]["roleOf"] = (threadId) =>
    Effect.map(threadRoles.get(threadId), (entry) =>
      entry === undefined
        ? undefined
        : entry.role === "captain" || entry.orderId === undefined
          ? { role: "captain" as const, captainId: entry.captainId }
          : { role: entry.role, captainId: entry.captainId, orderId: entry.orderId },
    );

  yield* store.releaseAllClaims();
  const startupCaptains = yield* store.listCaptains({});
  for (const captain of startupCaptains) {
    if (captain.status !== "released") {
      yield* assignRole(
        captain.threadId,
        { role: "captain", captainId: captain.id },
        T3_CODE_CAPTAIN_ROLE_INSTRUCTIONS,
      );
    }
  }
  for (const order of yield* store.listCrewOrders()) {
    const captain = startupCaptains.find((candidate) => candidate.id === order.captainId);
    if (order.threadId === null || captain === undefined) continue;
    yield* crewRole(captain, order);
    if (order.state === "reviewing" && order.review !== null && order.review.finishedAt === null) {
      yield* reviewerRole(captain, order, order.review.threadId);
    }
  }
  yield* scheduler.register("captain-orders", processDue);

  return CaptainService.of({
    create,
    list,
    get,
    release,
    roleOf,
    requireCaptain,
    requireCrew,
    requireReviewer,
    crewOf,
    createOrder,
    listOrders,
    readOrder,
    sendToOrder,
    answerOrder,
    retryOrder,
    dropOrder,
    landOrder,
    listOrdersOf,
    landOrderById,
    retryOrderById,
    dropOrderById,
    update,
    crewReport,
    submitReview,
    reviewerEnded,
    openEscalation,
    escalate,
    listEscalations,
    resolveEscalation,
    touchActivity,
    drain,
    subscribeSignals: PubSub.subscribe(signals),
  });
});

export const layer = Layer.effect(CaptainService, make);
