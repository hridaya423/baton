// @effect-diagnostics nodeBuiltinImport:off - drives real git the way a crew thread would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { REVIEW_DIFF_MAX_BYTES } from "./captainMessages.ts";
import { environmentId, makeHarness, shell } from "./Captain.testkit.ts";
import { CREW_HOST_TOOL_NAMES } from "./RemoteCrew.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const crewThreadId = ThreadId.make("thread:hosted-crew");
const userThreadId = ThreadId.make("thread:users-own");
const branch = "crew/evening-captain/readme-abc123";
const linkOrigin = {
  sessionId: "session:macbook",
  label: "MacBook",
  access: "full-access",
} as const;

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "captain-hosted-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "captain-hosted-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

type CallOutcome = Effect.Effect<
  McpSchema.CallToolResult,
  Effect.Error<ReturnType<McpServer.McpServer["Service"]["callTool"]>>
>;

const linkedScope = (
  access: "read-only" | "auto" | "full-access",
  linked = true,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "hosted-test",
  thread: undefined,
  client: { sessionId: linkOrigin.sessionId, label: linkOrigin.label, access, linked },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const makeCrewRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "captain-hosted-" });
  const remote = `${root}/origin.git`;
  const dir = `${root}/repo`;
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", dir);
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  NodeFS.writeFileSync(`${dir}/README.md`, "# app\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-u", "origin", "main");
  git(dir, "checkout", "-b", branch);
  NodeFS.writeFileSync(`${dir}/README.md`, "# app\nhello from the crew\n");
  git(dir, "commit", "-am", "crew change");
  return { root, remote, dir };
});

const withHostedCrew = <A, E, R>(
  body: (input: {
    readonly dir: string;
    readonly remote: string;
    readonly call: (
      name: string,
      args: Record<string, unknown>,
      scope?: McpInvocationContext.McpInvocationScope,
    ) => CallOutcome;
  }) => Effect.Effect<A, E, R | McpServer.McpServer>,
) =>
  Effect.gen(function* () {
    const repo = yield* makeCrewRepo;
    const harness = makeHarness({
      repo: { dir: repo.dir, worktreeRoot: `${repo.root}/worktrees` },
    });
    harness.shells.set(crewThreadId, shell(crewThreadId, { worktreePath: repo.dir, linkOrigin }));
    harness.shells.set(userThreadId, shell(userThreadId, { worktreePath: repo.dir }));
    const layer = McpHttpServer.layerCaptainToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(harness.layer),
    );
    return yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        name: string,
        args: Record<string, unknown>,
        scope = linkedScope("full-access"),
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      return yield* body({ ...repo, call });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer));

const refused = (outcome: CallOutcome) =>
  outcome.pipe(
    Effect.result,
    Effect.map((result) => result._tag === "Failure" || result.success.isError === true),
  );

const payload = (result: McpSchema.CallToolResult | undefined) => {
  assert.isFalse(result?.isError === true, JSON.stringify(result?.content));
  return result?.structuredContent as Record<string, unknown>;
};

it.effect("the hosted crew tools answer only a link paired with full access", () =>
  withHostedCrew(({ call }) =>
    Effect.gen(function* () {
      const args = { threadId: crewThreadId };
      assert.isTrue(yield* refused(call("crew_worktree_check", args, linkedScope("read-only"))));
      assert.isTrue(yield* refused(call("crew_worktree_check", args, linkedScope("auto"))));
      assert.isTrue(
        yield* refused(call("crew_worktree_check", args, linkedScope("full-access", false))),
      );
      assert.isTrue(
        yield* refused(call("crew_worktree_push", { ...args, branch }, linkedScope("auto"))),
      );
      assert.isTrue(yield* refused(call("crew_approval", args, linkedScope("read-only"))));

      assert.isString(payload(yield* call("crew_worktree_check", args)).head);
    }),
  ),
);

it.effect("crew_worktree_check runs the command in the crew's worktree and reports its exit", () =>
  withHostedCrew(({ call, dir }) =>
    Effect.gen(function* () {
      const failed = payload(
        yield* call("crew_worktree_check", { threadId: crewThreadId, command: "test -f DONE" }),
      );
      assert.equal(failed.head, git(dir, "rev-parse", "HEAD"));
      assert.equal((failed.check as { exit: number }).exit, 1);

      NodeFS.writeFileSync(`${dir}/DONE`, "ok");
      const passed = payload(
        yield* call("crew_worktree_check", { threadId: crewThreadId, command: "test -f DONE" }),
      );
      assert.equal((passed.check as { exit: number }).exit, 0);
      assert.isUndefined(passed.diff);
    }),
  ),
);

it.effect(
  "crew_worktree_check returns the diff, or only the changed files over the review cap",
  () =>
    withHostedCrew(({ call, dir }) =>
      Effect.gen(function* () {
        const small = payload(
          yield* call("crew_worktree_check", { threadId: crewThreadId, baseRef: "main" }),
        );
        assert.include((small.diff as { text: string }).text, "+hello from the crew");

        NodeFS.writeFileSync(`${dir}/big.txt`, "x".repeat(REVIEW_DIFF_MAX_BYTES + 1_000));
        git(dir, "add", "big.txt");
        git(dir, "commit", "-m", "big");
        const big = payload(
          yield* call("crew_worktree_check", { threadId: crewThreadId, baseRef: "main" }),
        );
        assert.isUndefined((big.diff as { text?: string }).text);
        assert.include((big.diff as { files: string }).files, "big.txt");
      }),
    ),
);

it.effect(
  "crew_worktree_push pushes only the crew branch the worktree is on, only for a link's thread",
  () =>
    withHostedCrew(({ call, remote }) =>
      Effect.gen(function* () {
        const pushed = payload(
          yield* call("crew_worktree_push", { threadId: crewThreadId, branch }),
        );
        assert.equal(pushed.outcome, "pushed");
        assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`).length, 40);
        const again = payload(
          yield* call("crew_worktree_push", { threadId: crewThreadId, branch }),
        );
        assert.equal(again.outcome, "up_to_date");

        assert.isTrue(
          yield* refused(call("crew_worktree_push", { threadId: crewThreadId, branch: "main" })),
        );
        assert.isTrue(
          yield* refused(
            call("crew_worktree_push", { threadId: crewThreadId, branch: "crew/other/branch-1" }),
          ),
        );
        assert.isTrue(
          yield* refused(call("crew_worktree_push", { threadId: userThreadId, branch })),
        );
        assert.isTrue(yield* refused(call("crew_worktree_check", { threadId: userThreadId })));
      }),
    ),
);

it.effect("a push the remote rejects reports git's reason, not a broken worktree", () =>
  withHostedCrew(({ call, dir, remote }) =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(
        `${remote}/hooks/pre-receive`,
        "#!/bin/sh\necho 'Permission to trial.git denied to someone-else.' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(`${dir}/rejected.md`, "rejected\n");
      git(dir, "add", ".");
      git(dir, "-c", "user.name=Crew", "-c", "user.email=crew@example.com", "commit", "-m", "x");
      const result = yield* call("crew_worktree_push", { threadId: crewThreadId, branch });
      assert.isTrue(result.isError === true);
      const text = JSON.stringify(result.content);
      assert.include(text, "denied to someone-else");
      assert.notInclude(text, "worktree could not be used");
    }),
  ),
);

it.effect(
  "the tools a captain calls on its crew's machine are the ones every other caller never sees",
  () =>
    withHostedCrew(() =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const hidden = server.tools
          .filter(
            (registered) =>
              Context.getOrUndefined(registered.annotations, McpSchema.EnabledWhen) ===
              McpInvocationContext.visibleToFullAccessLinks,
          )
          .map((registered) => registered.tool.name);
        assert.deepEqual(hidden.toSorted(), [...CREW_HOST_TOOL_NAMES].toSorted());
      }),
    ),
);
