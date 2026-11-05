import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadRoles from "../orchestration-v2/ThreadRoles.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CaptainReactor from "./CaptainReactor.ts";
import * as CaptainService from "./CaptainService.ts";
import * as CaptainStore from "./CaptainStore.ts";

const projectId = ProjectId.make("project:captain-scenario");
const environmentId = EnvironmentId.make("environment:captain-scenario");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" } as const;
const baseSha = "0123456789abcdef0123456789abcdef01234567";
const captainThreadId = ThreadId.make("thread:scenario-captain");

const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

const adapterFor = (id: ProviderInstanceId, driver: string) =>
  ({
    instanceId: id,
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("provider execution is disabled in captain scenarios"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const adapters = [adapterFor(instanceId, "codex"), adapterFor(claudeInstanceId, "claudeAgent")];

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "captain-scenario", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "captain-scenario", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

class Probe extends Context.Service<
  Probe,
  {
    readonly worktrees: Queue.Queue<{
      readonly branch: string;
      readonly startRef: string;
      readonly path: string;
    }>;
    readonly wakes: Queue.Queue<string>;
    readonly responses: Queue.Queue<{
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly decision?: string;
      readonly answers?: Record<string, unknown>;
    }>;
    readonly root: string;
  }
>()("t3/captains/CaptainScenario.test/Probe") {}

const layerProbe = Layer.effect(
  Probe,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      worktrees: yield* Queue.unbounded<{
        readonly branch: string;
        readonly startRef: string;
        readonly path: string;
      }>(),
      wakes: yield* Queue.unbounded<string>(),
      responses: yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly requestId: string;
        readonly decision?: string;
        readonly answers?: Record<string, unknown>;
      }>(),
      root: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-captain-scenario-worktrees-" }),
    };
  }),
).pipe(Layer.provide(NodeServices.layer));

const provider = (id: ProviderInstanceId, driver: string, models: ReadonlyArray<string>) =>
  ({
    instanceId: id,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map((slug) => ({ slug })),
  }) as never;

const providers = [
  provider(instanceId, "codex", ["gpt-5.1-codex", "gpt-5.5"]),
  provider(claudeInstanceId, "claudeAgent", ["claude-sonnet-5-5", "claude-opus-5-5"]),
];

const makeLayer = () => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(adapters);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "captain-scenario" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagementBase = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerThreadManagement = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { wakes, responses } = yield* Probe;
      return ThreadManagement.ThreadManagementService.of({
        ...threads,
        dispatch: (command) =>
          command.type === "runtime-request.respond"
            ? Queue.offer(responses, {
                threadId: command.threadId,
                requestId: command.requestId,
                ...("decision" in command && command.decision !== undefined
                  ? { decision: command.decision }
                  : {}),
                ...("answers" in command && command.answers !== undefined
                  ? { answers: command.answers as Record<string, unknown> }
                  : {}),
              }).pipe(Effect.as({ sequence: 0 } as never))
            : threads
                .dispatch(command)
                .pipe(
                  Effect.tap(() =>
                    command.type === "message.dispatch" && command.text.startsWith("Crew report.")
                      ? Queue.offer(wakes, command.text)
                      : Effect.void,
                  ),
                ),
      });
    }),
  ).pipe(Layer.provide(layerThreadManagementBase));

  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: () => Effect.succeedSome(project),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.unwrap(
      Effect.gen(function* () {
        const { worktrees, root } = yield* Probe;
        const fileSystem = yield* FileSystem.FileSystem;
        return Layer.mock(GitWorkflow.GitWorkflowService)({
          createWorktree: (input) => {
            const path = `${root}/${(input.newRefName ?? "").replaceAll("/", "-")}`;
            return fileSystem.makeDirectory(path, { recursive: true }).pipe(
              Effect.andThen(
                Queue.offer(worktrees, {
                  branch: input.newRefName ?? "",
                  startRef: input.refName ?? "",
                  path,
                }),
              ),
              Effect.orDie,
              Effect.as({
                worktree: { path, refName: input.newRefName, headSha: baseSha },
              } as never),
            );
          },
          hasCommit: () => Effect.succeed(true),
          remoteExists: () => Effect.succeed(false),
          remoteBranchExists: () => Effect.succeed(false),
          removeWorktree: () => Effect.void,
          deleteLocalBranch: () => Effect.void,
        });
      }),
    ),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.never,
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    layerServerSettings,
    ProviderRegistryMock.layer(providers),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagementBase,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );

  const layerExternal = Layer.mergeAll(
    layerLaunch,
    layerThreadManagement,
    layerExternalServices,
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: (input) =>
        Effect.succeed({
          exitCode: 0,
          stdout: input.args.includes("--name-status")
            ? "M\tREADME.md\n"
            : "diff --git a/README.md b/README.md\n+hello\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        } as never),
      resolvePrimaryRemoteName: () => Effect.fail(new Error("no remote") as never),
      resolveDefaultBranchName: () => Effect.succeed(null),
      resolveCommit: ({ revision }) =>
        revision === "main"
          ? Effect.succeed({ commitSha: baseSha })
          : Effect.fail(new Error("no ref") as never),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-captain-scenario-" }),
    Scheduler.layer,
    ThreadRoles.layer,
    ProcessRunner.layer,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

  const layer = McpHttpServer.layerCaptainToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(CaptainReactor.layer),
    Layer.provideMerge(CaptainService.layer),
    Layer.provideMerge(CaptainStore.layer),
    Layer.provideMerge(layerExternal),
    Layer.provideMerge(layerProbe),
  );

  return layer;
};

const scopeFor = (
  threadId: ThreadId,
  role: "captain" | "crew" | "reviewer",
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: threadId,
  thread: {
    threadId,
    providerSessionId: threadId,
    providerInstanceId: role === "reviewer" ? claudeInstanceId : instanceId,
    role,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

it.effect(
  "captain scenario: four orders, an answered question, an approval, a failed check, a rejected review and a report order, with no scheduled tasks",
  () =>
    Effect.gen(function* () {
      const probe = yield* Probe;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const captains = yield* CaptainService.CaptainService;
      const reactor = yield* CaptainReactor.CaptainReactor;
      const server = yield* McpServer.McpServer;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* reactor.start();
      const captainScope = scopeFor(captainThreadId, "captain");

      const call = (
        name: string,
        args: Record<string, unknown>,
        scope: McpInvocationContext.McpInvocationScope,
      ) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flatMap((result) =>
            result.isError === true
              ? Effect.die(`${name} failed: ${JSON.stringify(result.content)}`)
              : Effect.succeed(result.structuredContent as Record<string, any>),
          ),
        );
      const nextWake = Effect.gen(function* () {
        yield* TestClock.adjust("1500 millis");
        return yield* Queue.take(probe.wakes);
      });
      const crewOf = (created: Record<string, any>) =>
        ThreadId.make(`captain-crew:${created.orderId as string}`);
      const worktreeOf = (created: Record<string, any>) =>
        Effect.map(threads.getThreadShell(crewOf(created)), (shell) => {
          assert.isNotNull(shell?.worktreePath);
          return shell?.worktreePath as string;
        });
      const orderOf = (created: Record<string, any>) =>
        Effect.map(
          Effect.suspend(() => captains.listOrders(captain)),
          (orders) => orders.find((candidate) => candidate.id === created.orderId)!,
        );
      const messagesOf = (threadId: ThreadId) =>
        Effect.map(threads.getThreadProjection(threadId), (projection) =>
          projection.messages.map((message) => message.text),
        );
      const counts = Effect.map(call("order_list", {}, captainScope), (listed) => listed.counts);

      yield* launches.launch({
        commandId: CommandId.make("command:scenario:captain"),
        threadId: captainThreadId,
        projectId,
        title: "Evening captain",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message:scenario:captain"),
          text: "Captain this project.",
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      });
      const captain = yield* captains.create({ threadId: captainThreadId });

      const audit = yield* call(
        "order_create",
        {
          title: "Audit docs",
          brief: "Read the docs and list the gaps.",
          kind: "report",
          touches: [],
          doneCheck: "test -f AUDIT.md",
        },
        captainScope,
      );
      const readme = yield* call(
        "order_create",
        {
          title: "Juice up the README",
          brief: "Rewrite the README intro.",
          kind: "change",
          touches: ["README.md"],
          doneCheck: "test -f DONE",
        },
        captainScope,
      );
      const api = yield* call(
        "order_create",
        {
          title: "Tidy the API",
          brief: "Rename the handlers.",
          kind: "change",
          touches: ["api/**"],
        },
        captainScope,
      );
      const badges = yield* call(
        "order_create",
        {
          title: "README badges",
          brief: "Add badges to the README.",
          kind: "change",
          touches: ["README.md"],
        },
        captainScope,
      );
      assert.deepEqual(
        [audit.state, readme.state, api.state, badges.state],
        ["running", "running", "running", "queued"],
      );
      for (let launched = 0; launched < 3; launched++) yield* Queue.take(probe.worktrees);

      const apiCrew = crewOf(api);
      const apiProjection = yield* threads.getThreadProjection(apiCrew);
      const apiRun = apiProjection.runs[0]!;
      const now = yield* DateTime.now;
      const questionId = RuntimeRequestId.make("request:scenario:question");
      yield* projections.apply({
        id: EventId.make("event:scenario:question-item"),
        type: "turn-item.updated",
        threadId: apiCrew,
        occurredAt: now,
        payload: {
          type: "user_input_request",
          id: TurnItemId.make("item:scenario:question"),
          threadId: apiCrew,
          runId: apiRun.id,
          nodeId: apiRun.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "pending",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId: questionId,
          questions: [
            {
              id: "style",
              header: "Naming",
              question: "Should handlers be camelCase or snake_case?",
              options: [],
            },
          ],
        },
      } as OrchestrationV2DomainEvent);
      const asked = {
        id: EventId.make("event:scenario:question-request"),
        type: "runtime-request.updated",
        threadId: apiCrew,
        occurredAt: now,
        payload: {
          id: questionId,
          nodeId: apiRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      } as OrchestrationV2DomainEvent;
      yield* projections.apply(asked);
      yield* reactor.handle(asked);
      const questionWake = yield* nextWake;
      assert.include(questionWake, "Tidy the API");
      assert.include(questionWake, "asks: Should handlers be camelCase or snake_case?");

      const answered = yield* call(
        "order_answer",
        { orderId: api.orderId, text: "camelCase." },
        captainScope,
      );
      assert.equal(answered.delivery, "steered");
      const answer = yield* Queue.take(probe.responses);
      assert.equal(answer.threadId, apiCrew);
      assert.equal(answer.requestId, questionId);
      assert.deepEqual(answer.answers, { style: "camelCase." });

      const auditCrew = crewOf(audit);
      const auditRun = (yield* threads.getThreadProjection(auditCrew)).runs[0]!;
      const approvalId = RuntimeRequestId.make("request:scenario:approval");
      yield* projections.apply({
        id: EventId.make("event:scenario:approval-item"),
        type: "turn-item.updated",
        threadId: auditCrew,
        occurredAt: now,
        payload: {
          type: "approval_request",
          id: TurnItemId.make("item:scenario:approval"),
          threadId: auditCrew,
          runId: auditRun.id,
          nodeId: auditRun.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "pending",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId: approvalId,
          requestKind: "command",
          prompt: "Run npm publish?",
        },
      } as OrchestrationV2DomainEvent);
      const approval = {
        id: EventId.make("event:scenario:approval-request"),
        type: "runtime-request.updated",
        threadId: auditCrew,
        occurredAt: now,
        payload: {
          id: approvalId,
          nodeId: auditRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      } as OrchestrationV2DomainEvent;
      yield* projections.apply(approval);
      yield* reactor.handle(approval);
      assert.include(yield* nextWake, "needs you: Audit docs needs approval: Run npm publish?");
      const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
      assert.deepEqual(
        open.map((escalation) => escalation.kind),
        ["approval"],
      );
      assert.equal((yield* call("order_list", {}, captainScope)).needsYou, 1);
      yield* captains.resolveEscalation({ escalationId: open[0]!.id, resolution: "approve" });
      const decided = yield* Queue.take(probe.responses);
      assert.equal(decided.threadId, auditCrew);
      assert.equal(decided.requestId, approvalId);
      assert.equal(decided.decision, "accept");
      assert.include(
        yield* nextWake,
        "you resolved: Audit docs needs approval: Run npm publish? → approve",
      );
      assert.equal((yield* call("order_list", {}, captainScope)).needsYou, 0);

      const readmeCrew = crewOf(readme);
      yield* call(
        "crew_report",
        { status: "done", summary: "README intro rewritten." },
        scopeFor(readmeCrew, "crew"),
      );
      yield* captains.drain;
      const failedWake = yield* nextWake;
      assert.include(failedWake, "verify failed (exit 1), sent back");
      assert.equal((yield* orderOf(readme)).state, "running");
      assert.isTrue(
        (yield* messagesOf(readmeCrew)).some((text) =>
          text.includes("The done-check failed. Fix it and call crew_report done again."),
        ),
      );

      yield* fileSystem.writeFileString(`${yield* worktreeOf(readme)}/DONE`, "ok");
      yield* call(
        "crew_report",
        { status: "done", summary: "README intro rewritten, DONE written." },
        scopeFor(readmeCrew, "crew"),
      );
      yield* captains.drain;
      assert.include(yield* nextWake, "verify passed");
      const readmeReview = (yield* orderOf(readme)).review;
      assert.equal((yield* orderOf(readme)).state, "reviewing");
      assert.isNotNull(readmeReview);
      const reviewerShell = yield* threads.getThreadShell(readmeReview!.threadId);
      assert.equal(reviewerShell?.groupedUnderThreadId, readmeCrew);
      assert.equal(readmeReview?.model.instanceId, "claudeAgent");
      const reviewerBrief = yield* messagesOf(readmeReview!.threadId);
      assert.include(reviewerBrief[0] ?? "", "diff --git a/README.md b/README.md");
      assert.include(reviewerBrief[0] ?? "", "review_submit");
      yield* call(
        "review_submit",
        { verdict: "approve", findings: [] },
        scopeFor(readmeReview!.threadId, "reviewer"),
      );
      assert.include(yield* nextWake, "accepted (reviewed by claude-opus-5-5)");
      assert.equal((yield* orderOf(readme)).state, "accepted");
      const admitted = yield* Queue.take(probe.worktrees);
      assert.match(admitted.branch, /^crew\/evening-captain\/readme-badges-/);
      assert.equal((yield* orderOf(badges)).state, "running");

      yield* call(
        "crew_report",
        { status: "done", summary: "Handlers renamed." },
        scopeFor(apiCrew, "crew"),
      );
      yield* captains.drain;
      const firstReview = (yield* orderOf(api)).review!;
      yield* call(
        "review_submit",
        {
          verdict: "reject",
          findings: [
            {
              severity: "high",
              file: "api/routes.ts",
              line: 12,
              scenario: "The old handler name is still exported, so callers break.",
            },
          ],
        },
        scopeFor(firstReview.threadId, "reviewer"),
      );
      const rejectedWake = yield* nextWake;
      assert.include(rejectedWake, "review rejected (1 finding), sent back");
      assert.equal((yield* orderOf(api)).state, "running");
      assert.isTrue(
        (yield* messagesOf(apiCrew)).some((text) =>
          text.includes("[high] api/routes.ts:12: The old handler name is still exported"),
        ),
      );
      yield* call(
        "crew_report",
        { status: "done", summary: "Old names removed." },
        scopeFor(apiCrew, "crew"),
      );
      yield* captains.drain;
      const secondReview = (yield* orderOf(api)).review!;
      assert.equal(secondReview.round, 2);
      assert.notEqual(secondReview.threadId, firstReview.threadId);
      const secondBrief = yield* messagesOf(secondReview.threadId);
      assert.include(secondBrief[0] ?? "", "Check each of them first");
      assert.include(secondBrief[0] ?? "", "The old handler name is still exported");
      yield* call(
        "review_submit",
        { verdict: "approve", findings: [] },
        scopeFor(secondReview.threadId, "reviewer"),
      );
      assert.equal((yield* orderOf(api)).state, "accepted");

      yield* fileSystem.writeFileString(`${yield* worktreeOf(audit)}/AUDIT.md`, "# Gaps");
      yield* call(
        "crew_report",
        { status: "done", summary: "Gaps listed.", reportMd: "# Gaps" },
        scopeFor(auditCrew, "crew"),
      );
      yield* captains.drain;
      const audited = yield* orderOf(audit);
      assert.equal(audited.state, "done");
      assert.equal(audited.verify?.exit, 0);
      assert.isNull(audited.review);

      assert.deepEqual(yield* counts, {
        queued: 0,
        running: 1,
        verifying: 0,
        verify_failed: 0,
        reviewing: 0,
        accepted: 2,
        done: 1,
        dropped: 0,
      });
      const scheduled = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM scheduled_tasks`;
      assert.equal(scheduled[0]?.count, 0);
    }).pipe(Effect.provide(makeLayer())),
);
