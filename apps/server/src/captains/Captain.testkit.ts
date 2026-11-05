import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
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
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CaptainReactor from "./CaptainReactor.ts";
import * as CaptainService from "./CaptainService.ts";
import * as CaptainStore from "./CaptainStore.ts";

const projectId = ProjectId.make("project:captain-test");
export const environmentId = EnvironmentId.make("environment:captain-test");
export const captainThreadId = ThreadId.make("thread:captain");
export const baseSha = "0123456789abcdef0123456789abcdef01234567";
const instanceId = ProviderInstanceId.make("codex");

export const shell = (
  id: ThreadId,
  fields: {
    readonly runtimeMode?: RuntimeMode;
    readonly subagent?: boolean;
    readonly lastError?: string | null;
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
}

/** In-memory stand-ins for the thread services, so tests read what the captain code asked of them. */
export const makeHarness = (options: CaptainHarnessOptions = {}) => {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [captainThreadId, shell(captainThreadId, options.captainShell)],
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
            shells.set(threadId, shell(threadId, { runtimeMode: input.runtimeMode }));
            return { threadId, projection: {} as never, resumed: false };
          }),
  });

  const layerExternal = Layer.mergeAll(
    threads,
    launchLayer,
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot: "/repo" } as never),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
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
