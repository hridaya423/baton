// @effect-diagnostics nodeBuiltinImport:off - drives real git the way a crew thread would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type Captain,
  type CaptainMcpOrderCreateInput,
  type CaptainOrder,
  type CaptainOrderId,
  SourceControlProviderError,
  SourceControlProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import * as CaptainService from "./CaptainService.ts";
import {
  type CaptainHarness,
  type CaptainHarnessOptions,
  captainThreadId,
  makeHarness,
} from "./Captain.testkit.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const gitResult = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stderr: result.stderr };
};

interface Repo {
  readonly root: string;
  readonly remote: string;
  readonly dir: string;
  readonly worktreeRoot: string;
}

const makeRepo = (options: { readonly remote?: boolean } = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "captain-land-" });
    const remote = `${root}/origin.git`;
    const dir = `${root}/repo`;
    const worktreeRoot = `${root}/worktrees`;
    git(root, "init", "--bare", "-b", "main", remote);
    git(root, "init", "-b", "main", dir);
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    NodeFS.writeFileSync(`${dir}/README.md`, "# app\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init");
    if (options.remote !== false) {
      git(dir, "remote", "add", "origin", remote);
      git(dir, "push", "-u", "origin", "main");
    }
    return { root, remote, dir, worktreeRoot } satisfies Repo;
  });

const withRepo = <A, E, R>(
  options: Omit<CaptainHarnessOptions, "repo"> & { readonly remote?: boolean },
  body: (harness: CaptainHarness, repo: Repo) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const repo = yield* makeRepo(options.remote === undefined ? {} : { remote: options.remote });
    const harness = makeHarness({
      ...options,
      repo: { dir: repo.dir, worktreeRoot: repo.worktreeRoot },
    });
    return yield* body(harness, repo).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer));

const order = (
  fields: Partial<CaptainMcpOrderCreateInput> & Pick<CaptainMcpOrderCreateInput, "title">,
): CaptainMcpOrderCreateInput => ({
  brief: `Do ${fields.title}.`,
  kind: "change",
  touches: [`${fields.title}/`],
  ...fields,
});

const makeCaptain = Effect.gen(function* () {
  const captains = yield* CaptainService.CaptainService;
  return yield* captains.create({ threadId: captainThreadId });
});

const create = (captain: Captain, input: CaptainMcpOrderCreateInput) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    return (yield* captains.createOrder({
      captain,
      order: input,
      runtimeModeCeiling: "full-access",
    })).order;
  });

const find = (captain: Captain, orderId: CaptainOrderId) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    const found = (yield* captains.listOrders(captain)).find(
      (candidate) => candidate.id === orderId,
    );
    assert.isDefined(found);
    return found as CaptainOrder;
  });

const crewThread = (found: CaptainOrder) => {
  assert.isNotNull(found.threadId);
  return found.threadId as ThreadId;
};

const worktreeOf = (harness: CaptainHarness, found: CaptainOrder) => {
  const path = harness.shells.get(crewThread(found))?.worktreePath;
  assert.isString(path);
  return path as string;
};

const branchOf = (found: CaptainOrder) => {
  assert.isNotNull(found.branch);
  return found.branch as string;
};

const crewCommit = (
  harness: CaptainHarness,
  found: CaptainOrder,
  file: string,
  content: string,
) => {
  const cwd = worktreeOf(harness, found);
  NodeFS.writeFileSync(`${cwd}/${file}`, content);
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Crew", "-c", "user.email=crew@example.com", "commit", "-m", file);
};

const accept = (captain: Captain, found: CaptainOrder) =>
  Effect.gen(function* () {
    const captains = yield* CaptainService.CaptainService;
    yield* captains.crewReport({
      threadId: crewThread(found),
      report: { status: "done", summary: `${found.title} is done.` },
    });
    yield* captains.drain;
    const reviewing = yield* find(captain, found.id);
    assert.equal(reviewing.state, "reviewing");
    yield* captains.submitReview({
      threadId: (reviewing.review as NonNullable<typeof reviewing.review>).threadId,
      review: { verdict: "approve", findings: [] },
    });
  });

const noteTexts = (subscription: PubSub.Subscription<CaptainService.CrewSignal>) =>
  PubSub.takeUpTo(subscription, 1_000).pipe(
    Effect.map((signals) =>
      [...signals].flatMap((signal) => (signal.kind === "note" ? [signal.text] : [])),
    ),
  );

const sentTo = (harness: CaptainHarness, threadId: ThreadId) =>
  harness.sends.filter((send) => send.threadId === threadId).map((send) => send.text);

it.effect(
  "pushes a branch order, asks before a merge, then rebases the next accepted order and sends a conflicting one back",
  () =>
    withRepo({}, (harness, repo) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;

        const pushed = yield* create(captain, order({ title: "docs", delivery: "branch" }));
        crewCommit(harness, pushed, "docs.md", "docs\n");
        yield* accept(captain, pushed);
        yield* captains.drain;
        const landedPush = yield* find(captain, pushed.id);
        assert.equal(landedPush.state, "landed");
        assert.equal(landedPush.land?.action, "branch");
        assert.isTrue(landedPush.land?.ok);
        assert.equal(
          git(repo.remote, "rev-parse", `refs/heads/${branchOf(pushed)}`),
          git(repo.dir, "rev-parse", `refs/heads/${branchOf(pushed)}`),
        );
        assert.isTrue(NodeFS.existsSync(worktreeOf(harness, pushed)));
        assert.deepEqual(
          (yield* noteTexts(signals)).filter((text) => /^land/.test(text)),
          ["landing", `landed: pushed ${branchOf(pushed)}`],
        );

        const merged = yield* create(
          captain,
          order({
            title: "banner",
            touches: ["b.txt"],
            delivery: "merge",
            doneCheck: "test -f b.txt",
          }),
        );
        const kept = yield* create(
          captain,
          order({
            title: "extras",
            touches: ["c.txt"],
            delivery: "none",
            doneCheck: `test -f c.txt && echo run >> '${repo.root}/c-runs.log'`,
          }),
        );
        const clashing = yield* create(
          captain,
          order({ title: "clash", touches: ["d/"], delivery: "none" }),
        );
        crewCommit(harness, merged, "b.txt", "from banner\n");
        crewCommit(harness, kept, "c.txt", "extras\n");
        crewCommit(harness, clashing, "b.txt", "from clash\n");
        const clashTip = git(worktreeOf(harness, clashing), "rev-parse", "HEAD");
        yield* accept(captain, merged);
        yield* accept(captain, kept);
        yield* accept(captain, clashing);
        yield* captains.drain;

        assert.equal((yield* find(captain, merged.id)).state, "accepted");
        const open = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
        assert.equal(open.length, 1);
        assert.equal(open[0]?.kind, "approval");
        assert.equal(open[0]?.summary, "Merge banner into main?");
        assert.deepEqual(open[0]?.options, ["merge", "hold"]);
        assert.include(yield* noteTexts(signals), "needs you: Merge banner into main?");
        const mergedTip = git(repo.dir, "rev-parse", `refs/heads/${branchOf(merged)}`);
        const checkRuns = () =>
          NodeFS.readFileSync(`${repo.root}/c-runs.log`, "utf8").trim().split("\n").length;
        assert.equal(checkRuns(), 1);
        assert.equal(git(repo.dir, "rev-parse", "main"), git(repo.remote, "rev-parse", "main"));

        yield* captains.resolveEscalation({
          escalationId: (open[0] as NonNullable<(typeof open)[number]>).id,
          resolution: "merge",
        });
        yield* captains.drain;

        const landedMerge = yield* find(captain, merged.id);
        assert.equal(landedMerge.state, "landed");
        assert.equal(landedMerge.land?.action, "merge");
        assert.equal(git(repo.dir, "rev-parse", "main"), mergedTip);
        assert.equal(NodeFS.readFileSync(`${repo.dir}/b.txt`, "utf8"), "from banner\n");
        assert.isFalse(NodeFS.existsSync(worktreeOf(harness, merged)));
        assert.notInclude(git(repo.dir, "branch", "--list"), branchOf(merged));
        assert.equal(git(repo.remote, "rev-parse", "main"), git(repo.dir, "rev-parse", "HEAD~1"));

        const rebased = yield* find(captain, kept.id);
        assert.equal(rebased.state, "accepted");
        git(repo.dir, "merge-base", "--is-ancestor", "main", `refs/heads/${branchOf(kept)}`);
        assert.equal(rebased.verify?.exit, 0);
        assert.equal(checkRuns(), 2);

        const sentBack = yield* find(captain, clashing.id);
        assert.equal(sentBack.state, "running");
        assert.equal(sentBack.retries, 1);
        assert.deepEqual(sentTo(harness, crewThread(clashing)), [
          "Rebase onto main conflicted in: b.txt. Resolve it and call crew_report done again.",
        ]);
        assert.equal(git(worktreeOf(harness, clashing), "rev-parse", "HEAD"), clashTip);
        assert.equal(git(worktreeOf(harness, clashing), "status", "--porcelain"), "");
        const lines = yield* noteTexts(signals);
        assert.include(lines, "rebased onto main, re-verifying");
        assert.include(lines, "rebase conflicted, sent back");
        assert.include(lines, `landed: merged ${branchOf(merged)} into main`);
      }),
    ),
);

it.effect("a merge that is put on hold stays accepted and is not asked about again", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const held = yield* create(captain, order({ title: "docs", delivery: "merge" }));
      crewCommit(harness, held, "docs.md", "docs\n");
      yield* accept(captain, held);
      yield* captains.drain;
      const [approval] = yield* captains.listEscalations({ captainId: captain.id, status: "open" });
      assert.isDefined(approval);

      const refused = yield* captains
        .resolveEscalation({
          escalationId: (approval as NonNullable<typeof approval>).id,
          resolution: "maybe",
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "invalid_state");
      yield* captains.resolveEscalation({
        escalationId: (approval as NonNullable<typeof approval>).id,
        resolution: "hold",
      });
      yield* captains.drain;

      assert.equal((yield* find(captain, held.id)).state, "accepted");
      assert.equal((yield* captains.listEscalations({ captainId: captain.id })).length, 1);
      assert.equal(git(repo.dir, "rev-parse", "main"), git(repo.remote, "rev-parse", "main"));
    }),
  ),
);

it.effect("order_land on a merge opens one approval, and the user's own land needs none", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const kept = yield* create(captain, order({ title: "docs", delivery: "none" }));
      const refusedEarly = yield* captains
        .landOrder({ captain, orderId: kept.id, delivery: undefined, approved: false })
        .pipe(Effect.flip);
      assert.equal(refusedEarly.reason, "invalid_state");
      crewCommit(harness, kept, "docs.md", "docs\n");
      yield* accept(captain, kept);
      yield* captains.drain;
      assert.equal((yield* find(captain, kept.id)).state, "accepted");

      const asked = yield* captains.landOrder({
        captain,
        orderId: kept.id,
        delivery: "merge",
        approved: false,
      });
      yield* captains.landOrder({ captain, orderId: kept.id, delivery: "merge", approved: false });
      assert.isTrue(asked.needsApproval);
      assert.equal(asked.order.state, "accepted");
      assert.equal(
        (yield* captains.listEscalations({ captainId: captain.id, status: "open" })).length,
        1,
      );
      yield* captains.drain;
      assert.equal(git(repo.dir, "rev-parse", "main"), git(repo.remote, "rev-parse", "main"));

      yield* captains.landOrderById({ orderId: kept.id, delivery: "merge" });
      yield* captains.drain;
      assert.equal((yield* find(captain, kept.id)).state, "landed");
      assert.equal(NodeFS.readFileSync(`${repo.dir}/docs.md`, "utf8"), "docs\n");
      assert.equal(
        (yield* captains.listEscalations({ captainId: captain.id, status: "open" })).length,
        0,
      );
    }),
  ),
);

it.effect("only moves the base ref when the checkout is not on the base or has changes", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const signals = yield* captains.subscribeSignals;
      const captain = yield* makeCaptain;
      const kept = yield* create(captain, order({ title: "docs", delivery: "none" }));
      crewCommit(harness, kept, "docs.md", "docs\n");
      yield* accept(captain, kept);
      yield* captains.drain;
      NodeFS.writeFileSync(`${repo.dir}/README.md`, "# app\nedited\n");

      yield* captains.landOrderById({ orderId: kept.id, delivery: "merge" });
      yield* captains.drain;

      assert.equal((yield* find(captain, kept.id)).state, "landed");
      assert.equal(git(repo.dir, "rev-parse", "main"), git(repo.dir, "rev-parse", "HEAD"));
      assert.isFalse(NodeFS.existsSync(`${repo.dir}/docs.md`));
      assert.equal(NodeFS.readFileSync(`${repo.dir}/README.md`, "utf8"), "# app\nedited\n");
      const line = (yield* noteTexts(signals)).find((text) => text.startsWith("landed: merged"));
      assert.include(
        line ?? "",
        "only the ref moved, because the checkout has uncommitted changes",
      );
    }),
  ),
);

it.effect("keeps a pushed-nowhere branch local when the project has no remote", () =>
  withRepo({ remote: false }, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const signals = yield* captains.subscribeSignals;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "docs" }));
      crewCommit(harness, created, "docs.md", "docs\n");
      yield* accept(captain, created);
      yield* captains.drain;

      assert.equal((yield* find(captain, created.id)).state, "landed");
      assert.include(
        yield* noteTexts(signals),
        `landed: kept ${branchOf(created)} local, no remote`,
      );
    }),
  ),
);

it.effect(
  "a failed push puts the order in land_failed without opening anything, and order_land retries it",
  () =>
    withRepo({}, (harness, repo) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const signals = yield* captains.subscribeSignals;
        const captain = yield* makeCaptain;
        const created = yield* create(captain, order({ title: "docs" }));
        crewCommit(harness, created, "docs.md", "docs\n");
        git(repo.dir, "remote", "set-url", "origin", `${repo.root}/missing.git`);
        yield* accept(captain, created);
        yield* captains.drain;

        const failed = yield* find(captain, created.id);
        assert.equal(failed.state, "land_failed");
        assert.isFalse(failed.land?.ok);
        assert.include(failed.land?.error ?? "", "Push failed");
        assert.isTrue(
          (yield* noteTexts(signals)).some((text) => text.startsWith("land failed: Push failed")),
        );
        assert.deepEqual(yield* captains.listEscalations({ captainId: captain.id }), []);

        git(repo.dir, "remote", "set-url", "origin", repo.remote);
        yield* captains.landOrder({
          captain,
          orderId: created.id,
          delivery: undefined,
          approved: false,
        });
        yield* captains.drain;
        const landed = yield* find(captain, created.id);
        assert.equal(landed.state, "landed");
        assert.isTrue(landed.land?.ok);
        assert.equal(
          git(repo.remote, "rev-parse", `refs/heads/${branchOf(created)}`),
          git(repo.dir, "rev-parse", `refs/heads/${branchOf(created)}`),
        );
      }),
    ),
);

it.effect("re-lands an order that was mid-land when the server stopped without pushing twice", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const created = yield* create(captain, order({ title: "docs" }));
      crewCommit(harness, created, "docs.md", "docs\n");
      yield* accept(captain, created);
      yield* captains.drain;
      const remoteTip = git(repo.remote, "rev-parse", `refs/heads/${branchOf(created)}`);
      assert.equal((yield* find(captain, created.id)).state, "landed");

      yield* sql`UPDATE captain_orders
        SET state = 'landing', land_json = NULL, claimed_at = '2026-11-05T00:00:00.000Z'
        WHERE order_id = ${created.id}`;
      const context = yield* Layer.build(Layer.fresh(CaptainService.layer));
      yield* Context.get(context, CaptainService.CaptainService).drain;

      const again = yield* find(captain, created.id);
      assert.equal(again.state, "landed");
      assert.isTrue(again.land?.ok);
      assert.equal(git(repo.remote, "rev-parse", `refs/heads/${branchOf(created)}`), remoteTip);
    }),
  ),
);

const pullRequestProvider = (state: {
  readonly existing: boolean;
  readonly fail?: string;
  readonly created: Array<{ readonly base: string; readonly head: string; readonly title: string }>;
}) => {
  const open: Array<{ readonly headRefName: string }> = [];
  const request = (head: string, number: number) => ({
    provider: "github",
    number,
    title: "title",
    url: `https://github.com/acme/app/pull/${number}`,
    baseRefName: "main",
    headRefName: head,
    state: "open",
    updatedAt: Option.none(),
  });
  return {
    resolve: () =>
      Effect.succeed({
        kind: "github",
        listChangeRequests: (input: { readonly headSelector: string }) =>
          Effect.sync(() =>
            state.existing
              ? [request(input.headSelector, 3)]
              : open.map((entry) => request(entry.headRefName, 7)),
          ),
        createChangeRequest: (input: {
          readonly baseRefName: string;
          readonly headSelector: string;
          readonly title: string;
        }) =>
          state.fail === undefined
            ? Effect.sync(() => {
                state.created.push({
                  base: input.baseRefName,
                  head: input.headSelector,
                  title: input.title,
                });
                open.push({ headRefName: input.headSelector });
              })
            : Effect.fail(
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("github"),
                  operation: "createChangeRequest",
                  cwd: "/repo",
                  detail: state.fail,
                }),
              ),
      } as never),
  };
};

it.effect(
  "opens a pull request once, links and watches it, and finds it again after a restart",
  () => {
    const created: Array<{ base: string; head: string; title: string }> = [];
    return withRepo(
      { sourceControl: pullRequestProvider({ existing: false, created }) },
      (harness, repo) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const captains = yield* CaptainService.CaptainService;
          const signals = yield* captains.subscribeSignals;
          const captain = yield* makeCaptain;
          const found = yield* create(captain, order({ title: "docs", delivery: "pr" }));
          crewCommit(harness, found, "docs.md", "docs\n");
          yield* accept(captain, found);
          yield* captains.drain;

          const landed = yield* find(captain, found.id);
          assert.equal(landed.state, "landed", JSON.stringify(landed.land));
          assert.equal(landed.land?.action, "pr");
          assert.equal(landed.prUrl, "https://github.com/acme/app/pull/7");
          assert.equal(landed.land?.prUrl, "https://github.com/acme/app/pull/7");
          assert.deepEqual(created, [{ base: "main", head: branchOf(found), title: "docs" }]);
          assert.include(
            yield* noteTexts(signals),
            "landed: PR https://github.com/acme/app/pull/7",
          );
          assert.equal(
            git(repo.remote, "rev-parse", `refs/heads/${branchOf(found)}`),
            git(repo.dir, "rev-parse", `refs/heads/${branchOf(found)}`),
          );
          const watch = harness.commands.find(
            (command) => command.type === "thread.pull-request.watch",
          );
          assert.isTrue(watch?.type === "thread.pull-request.watch" && watch.number === 7);

          yield* sql`UPDATE captain_orders SET state = 'landing', land_json = NULL, pr_url = NULL
        WHERE order_id = ${found.id}`;
          const context = yield* Layer.build(Layer.fresh(CaptainService.layer));
          yield* Context.get(context, CaptainService.CaptainService).drain;
          assert.equal(
            (yield* find(captain, found.id)).prUrl,
            "https://github.com/acme/app/pull/7",
          );
          assert.equal(created.length, 1);
        }),
    );
  },
);

it.effect("finds an open pull request for the branch instead of creating a second one", () => {
  const created: Array<{ base: string; head: string; title: string }> = [];
  return withRepo({ sourceControl: pullRequestProvider({ existing: true, created }) }, (harness) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const found = yield* create(captain, order({ title: "docs", delivery: "pr" }));
      crewCommit(harness, found, "docs.md", "docs\n");
      yield* accept(captain, found);
      yield* captains.drain;

      const landed = yield* find(captain, found.id);
      assert.equal(landed.state, "landed");
      assert.equal(landed.prUrl, "https://github.com/acme/app/pull/3");
      assert.equal(created.length, 0);
    }),
  );
});

it.effect(
  "a failed pull request leaves the pushed branch, fails the land and retries cleanly",
  () => {
    const created: Array<{ base: string; head: string; title: string }> = [];
    return withRepo(
      { sourceControl: pullRequestProvider({ existing: false, fail: "rate limited", created }) },
      (harness) =>
        Effect.gen(function* () {
          const captains = yield* CaptainService.CaptainService;
          const captain = yield* makeCaptain;
          const found = yield* create(captain, order({ title: "docs", delivery: "pr" }));
          crewCommit(harness, found, "docs.md", "docs\n");
          yield* accept(captain, found);
          yield* captains.drain;

          const failed = yield* find(captain, found.id);
          assert.equal(failed.state, "land_failed");
          assert.equal(failed.land?.action, "pr");
          assert.include(failed.land?.error ?? "", "rate limited");
          assert.isNull(failed.prUrl);
          assert.deepEqual(yield* captains.listEscalations({ captainId: captain.id }), []);
        }),
    );
  },
);

it.effect("the crew's pre-push hook refuses the base branch, force pushes and tags", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const captain = yield* makeCaptain;
      const found = yield* create(captain, order({ title: "docs" }));
      const cwd = worktreeOf(harness, found);
      const branch = branchOf(found);
      crewCommit(harness, found, "docs.md", "docs\n");

      const toMain = gitResult(cwd, ["push", "origin", "HEAD:refs/heads/main"]);
      assert.notEqual(toMain.status, 0);
      assert.include(toMain.stderr, "Baton refused this push: pushes to main are not allowed");
      assert.equal(git(repo.remote, "rev-parse", "main"), git(repo.dir, "rev-parse", "main"));

      assert.equal(gitResult(cwd, ["push", "origin", branch]).status, 0);
      git(
        cwd,
        "-c",
        "user.name=Crew",
        "-c",
        "user.email=crew@example.com",
        "commit",
        "--amend",
        "-m",
        "again",
      );
      const forced = gitResult(cwd, ["push", "--force", "origin", branch]);
      assert.notEqual(forced.status, 0);
      assert.include(forced.stderr, "force pushes are not allowed");

      git(cwd, "tag", "v1");
      const tagged = gitResult(cwd, ["push", "origin", "v1"]);
      assert.notEqual(tagged.status, 0);
      assert.include(tagged.stderr, "tag pushes are not allowed");

      const lease = ["push", `--force-with-lease=refs/heads/${branch}`, "origin", branch];
      assert.notEqual(gitResult(cwd, lease).status, 0);
      assert.equal(gitResult(cwd, lease, { BATON_LAND_QUEUE: "1" }).status, 0);

      assert.equal(gitResult(cwd, ["push", "origin", "HEAD:refs/heads/other"]).status, 0);
      git(
        cwd,
        "-c",
        "user.name=Crew",
        "-c",
        "user.email=crew@example.com",
        "commit",
        "--amend",
        "-m",
        "other",
      );
      const otherLease = [
        "push",
        "--force-with-lease=refs/heads/other",
        "origin",
        "HEAD:refs/heads/other",
      ];
      const rewritten = gitResult(cwd, otherLease, { BATON_LAND_QUEUE: "1" });
      assert.notEqual(rewritten.status, 0);
      assert.include(rewritten.stderr, "force pushes are not allowed");
    }),
  ),
);

it.effect("the crew's hooks directory still runs the repository's own hooks", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const marker = `${repo.root}/own-hook-ran`;
      NodeFS.writeFileSync(`${repo.dir}/.git/hooks/pre-push`, `#!/bin/sh\ntouch '${marker}'\n`, {
        mode: 0o755,
      });
      const captain = yield* makeCaptain;
      const found = yield* create(captain, order({ title: "docs" }));
      const cwd = worktreeOf(harness, found);
      crewCommit(harness, found, "docs.md", "docs\n");

      assert.equal(gitResult(cwd, ["push", "origin", branchOf(found)]).status, 0);
      assert.isTrue(NodeFS.existsSync(marker));
    }),
  ),
);

it.effect("dropping an order removes its clean worktree and keeps its branch", () =>
  withRepo({}, (harness, repo) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const found = yield* create(captain, order({ title: "docs" }));
      crewCommit(harness, found, "docs.md", "docs\n");
      const cwd = worktreeOf(harness, found);

      yield* captains.dropOrder({ captain, orderId: found.id, reason: "not needed" });

      assert.isFalse(NodeFS.existsSync(cwd));
      assert.include(git(repo.dir, "branch", "--list"), branchOf(found));
      assert.equal((yield* find(captain, found.id)).state, "dropped");
    }),
  ),
);

it.effect(
  "pausing holds the captain, interrupts running crew and stops admitting until resumed",
  () =>
    withRepo({}, (harness) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        const captain = yield* makeCaptain;
        const limited = yield* captains.update({ captainId: captain.id, charter: { crewCap: 1 } });
        assert.equal(limited.charter.crewCap, 1);
        const first = yield* create(
          limited,
          order({ title: "notes", kind: "report", touches: [] }),
        );
        const second = yield* create(
          limited,
          order({ title: "more notes", kind: "report", touches: [] }),
        );
        assert.equal(second.state, "queued");

        const paused = yield* captains.update({ captainId: captain.id, status: "paused" });
        assert.equal(paused.status, "paused");
        assert.isTrue(
          harness.commands.some(
            (command) => command.type === "queue.hold" && command.threadId === captainThreadId,
          ),
        );
        assert.deepEqual(
          harness.interrupts.map((interrupt) => interrupt.threadId),
          [crewThread(first)],
        );
        assert.equal((yield* find(paused, first.id)).state, "running");
        const refused = yield* captains
          .createOrder({
            captain: paused,
            order: order({ title: "late", kind: "report", touches: [] }),
            runtimeModeCeiling: "full-access",
          })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "captain_not_active");

        yield* captains.crewReport({
          threadId: crewThread(first),
          report: { status: "done", summary: "done" },
        });
        yield* captains.drain;
        assert.equal((yield* find(paused, first.id)).state, "done");
        assert.equal((yield* find(paused, second.id)).state, "queued");

        const resumed = yield* captains.update({ captainId: captain.id, status: "active" });
        assert.equal(resumed.status, "active");
        assert.isTrue(
          harness.commands.some(
            (command) => command.type === "queue.resume" && command.threadId === captainThreadId,
          ),
        );
        yield* captains.drain;
        assert.equal((yield* find(resumed, second.id)).state, "running");
      }),
    ),
);

it.effect("validates and merges charter updates", () =>
  withRepo({ captainShell: { runtimeMode: "auto" } }, () =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const captain = yield* makeCaptain;
      const reason = (charter: Parameters<typeof captains.update>[0]["charter"]) =>
        captains.update({ captainId: captain.id, charter }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      assert.equal(yield* reason({ crewCap: 0 }), "invalid_charter");
      assert.equal(yield* reason({ crewCap: 7 }), "invalid_charter");
      assert.equal(yield* reason({ retryLimit: 11 }), "invalid_charter");
      assert.equal(yield* reason({ stallMinutes: 0 }), "invalid_charter");
      assert.equal(yield* reason({ verifyTimeoutMinutes: 121 }), "invalid_charter");
      assert.equal(yield* reason({ crewRuntimeMode: "full-access" }), "invalid_charter");
      assert.equal(
        yield* reason({ reviewModel: { instanceId: "nowhere" as never, model: "x" } }),
        "invalid_charter",
      );

      const updated = yield* captains.update({
        captainId: captain.id,
        charter: {
          crewCap: 5,
          retryLimit: 2,
          defaultDelivery: "pr",
          crewRuntimeMode: "auto",
          reviewModel: { instanceId: "claudeAgent" as never, model: "claude-opus-5-5" },
        },
      });
      assert.equal(updated.charter.crewCap, 5);
      assert.equal(updated.charter.stallMinutes, 45);
      assert.equal(updated.charter.reviewModel?.model, "claude-opus-5-5");
      assert.deepEqual((yield* captains.list({}))[0]?.charter, updated.charter);

      const cleared = yield* captains.update({
        captainId: captain.id,
        charter: { reviewModel: null, verifyTimeoutMinutes: null },
      });
      assert.isUndefined(cleared.charter.reviewModel);
      assert.isUndefined(cleared.charter.verifyTimeoutMinutes);
      assert.equal(cleared.charter.crewCap, 5);
    }),
  ),
);
