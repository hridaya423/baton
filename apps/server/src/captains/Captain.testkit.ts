// @effect-diagnostics nodeBuiltinImport:off - the real-git mode makes linked worktrees the way a launch would.
import * as NodeChildProcess from "node:child_process";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadRoles from "../orchestration-v2/ThreadRoles.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CaptainReactor from "./CaptainReactor.ts";
import * as CaptainService from "./CaptainService.ts";
import * as CaptainStore from "./CaptainStore.ts";

const projectId = ProjectId.make("project:captain-test");
export const environmentId = EnvironmentId.make("environment:captain-test");
export const captainThreadId = ThreadId.make("thread:captain");
export const baseSha = "0123456789abcdef0123456789abcdef01234567";
const instanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

const provider = (
  id: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
  fields: { readonly enabled?: boolean } = {},
) =>
  ({
    instanceId: id,
    driver: ProviderDriverKind.make(driver),
    enabled: fields.enabled ?? true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map((slug) => ({ slug })),
  }) as never;

const defaultProviders = [
  provider(instanceId, "codex", ["gpt-5.4", "gpt-5.5", "gpt-5.5-mini"]),
  provider(claudeInstanceId, "claudeAgent", [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
  ]),
];

export const shell = (
  id: ThreadId,
  fields: {
    readonly runtimeMode?: RuntimeMode;
    readonly subagent?: boolean;
    readonly lastError?: string | null;
    readonly worktreePath?: string | null;
    readonly linkOrigin?: {
      readonly sessionId: string;
      readonly label: string;
      readonly access: "full-access";
    };
  } = {},
) =>
  ({
    id,
    projectId,
    title: id === captainThreadId ? "Evening captain" : id,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: fields.runtimeMode ?? "full-access",
    interactionMode: "default",
    lineage: {
      parentThreadId: fields.subagent === true ? captainThreadId : null,
      relationshipToParent: fields.subagent === true ? "subagent" : null,
    },
    pinnedAt: null,
    autoSettleDisabledAt: null,
    archivedAt: null,
    deletedAt: null,
    activeRunId: RunId.make(`run:live:${id}`),
    lastError: fields.lastError ?? null,
    worktreePath: fields.worktreePath ?? null,
    ...(fields.linkOrigin === undefined ? {} : { linkOrigin: fields.linkOrigin }),
    pendingRuntimeRequest: null,
    pullRequests: [],
    pendingBackgroundTasks: [],
  }) as unknown as OrchestrationV2ThreadShell;

type Command = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
>[0];
type LaunchInput = Parameters<ThreadLaunchService.ThreadLaunchService["Service"]["launch"]>[0];
type SendInput = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["sendToThread"]
>[0];
type InterruptInput = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["interruptThread"]
>[0];

export interface CaptainHarnessOptions {
  readonly captainShell?: Parameters<typeof shell>[1];
  readonly launchFails?: boolean;
  /** Where crew and reviewer worktrees are, so done-checks run in a directory that exists. */
  readonly worktreeDir?: string;
  readonly providers?: ReadonlyArray<unknown>;
  /** What `git diff` prints for a crew branch. */
  readonly diff?: string;
  /** Real git: the project is `dir`, and each launch adds a linked worktree under `worktreeRoot`. */
  readonly repo?: { readonly dir: string; readonly worktreeRoot: string };
  readonly sourceControl?: Partial<
    SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]
  >;
}

const layerMockGit = (options: CaptainHarnessOptions) =>
  Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (input) => {
      const diff = options.diff ?? "diff --git a/README.md b/README.md\n+hello\n";
      const names = input.args.includes("--name-status");
      const limit = input.maxOutputBytes ?? Number.MAX_SAFE_INTEGER;
      const stdout = names ? "M\tREADME.md\n" : diff;
      const truncated = Buffer.byteLength(stdout) > limit;
      return Effect.succeed({
        exitCode: 0,
        stdout: truncated ? stdout.slice(0, limit) : stdout,
        stderr: "",
        stdoutTruncated: truncated,
        stderrTruncated: false,
      } as never);
    },
    resolvePrimaryRemoteName: () => Effect.fail(new Error("no remote") as never),
    resolveDefaultBranchName: () => Effect.succeed(null),
    resolveCommit: ({ revision }) =>
      revision === "main"
        ? Effect.succeed({ commitSha: baseSha })
        : Effect.fail(new Error("no ref") as never),
  });

const layerRealGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-captain-git-" })),
  Layer.provide(VcsProcess.layer),
);

/** In-memory stand-ins for the thread services, so tests read what the captain code asked of them. */
export const makeHarness = (options: CaptainHarnessOptions = {}) => {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [captainThreadId, { ...shell(captainThreadId, options.captainShell), activeRunId: null }],
  ]);
  const commands: Array<Command> = [];
  const launches: Array<LaunchInput> = [];
  const sends: Array<SendInput> = [];
  const interrupts: Array<InterruptInput> = [];
  const messages = new Map<ThreadId, Array<{ role: string; text: string; createdAt: string }>>();
  const events = Effect.runSync(Queue.unbounded<OrchestrationV2DomainEvent>());
  const wakeQueue = Effect.runSync(Queue.unbounded<Command>());
  const turnItems = new Map<ThreadId, ReadonlyArray<unknown>>();

  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    dispatch: (command) =>
      Effect.gen(function* () {
        commands.push(command);
        if (command.type === "message.dispatch" && command.text.startsWith("Crew report.")) {
          yield* Queue.offer(wakeQueue, command);
        }
        return { sequence: commands.length } as never;
      }),
    sendToThread: (input) =>
      Effect.sync(() => {
        sends.push(input);
        return { delivery: "queued" } as never;
      }),
    interruptThread: (input) =>
      Effect.sync(() => {
        interrupts.push(input);
        return { type: "interrupt_requested" } as never;
      }),
    getThreadRecords: (threadId) =>
      Effect.succeed({
        messages: (messages.get(threadId) ?? []).map((message) => ({
          ...message,
          createdAt: DateTime.makeUnsafe(message.createdAt),
        })),
        turnItems: turnItems.get(threadId) ?? [],
      } as never),
    streamDomainEvents: Stream.fromQueue(events),
  });

  const launchLayer = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: (input) =>
      options.launchFails === true
        ? Effect.die(new Error("launch exploded"))
        : Effect.sync(() => {
            launches.push(input);
            const threadId = input.threadId ?? ThreadId.make(`thread:launched:${launches.length}`);
            const strategy = input.workspaceStrategy;
            let worktreePath =
              strategy.type === "existing_worktree"
                ? strategy.worktreePath
                : (options.worktreeDir ?? null);
            if (options.repo !== undefined && strategy.type === "worktree") {
              worktreePath = `${options.repo.worktreeRoot}/${threadId.replaceAll(/[^a-z0-9]+/gi, "-")}`;
              NodeChildProcess.execFileSync(
                "git",
                [
                  "worktree",
                  "add",
                  "-b",
                  strategy.branch ?? "crew",
                  worktreePath,
                  strategy.baseRef ?? "HEAD",
                ],
                { cwd: options.repo.dir, stdio: "pipe" },
              );
            }
            shells.set(threadId, shell(threadId, { runtimeMode: input.runtimeMode, worktreePath }));
            return { threadId, projection: {} as never, resumed: false };
          }),
  });

  const layerExternal = Layer.mergeAll(
    threads,
    launchLayer,
    ThreadRoles.layer,
    ProcessRunner.layer,
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed((options.providers ?? defaultProviders) as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot: options.repo?.dir ?? "/repo" } as never),
    }),
    options.repo === undefined ? layerMockGit(options) : layerRealGit,
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
      ...options.sourceControl,
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-captain-test-" }),
    Scheduler.layer,
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

  const layerService = CaptainService.layer.pipe(
    Layer.provideMerge(CaptainStore.layer),
    Layer.provideMerge(layerExternal),
  );
  const layer = CaptainReactor.layer.pipe(Layer.provideMerge(layerService));

  return {
    layer,
    shells,
    commands,
    launches,
    sends,
    interrupts,
    messages,
    turnItems,
    wakeQueue,
    emit: (event: OrchestrationV2DomainEvent) => Queue.offer(events, event),
  };
};

export type CaptainHarness = ReturnType<typeof makeHarness>;
