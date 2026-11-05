import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** The pre-push hook allows a crew branch rewrite only from a push that sets this. */
const LAND_QUEUE_ENV = { BATON_LAND_QUEUE: "1" } as const;

const GIT_TIMEOUT_MS = 2 * 60_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const ERROR_MAX_CHARS = 600;

type Git = GitVcsDriver.GitVcsDriver["Service"];

export type RebaseOutcome =
  | { readonly kind: "up_to_date" }
  | { readonly kind: "rebased" }
  | { readonly kind: "conflict"; readonly files: ReadonlyArray<string> }
  | { readonly kind: "error"; readonly message: string };

export type FastForwardOutcome =
  | { readonly kind: "already_there" }
  | { readonly kind: "base_moved" }
  | { readonly kind: "checkout" }
  | { readonly kind: "ref"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export type PushOutcome =
  | { readonly kind: "up_to_date" }
  | { readonly kind: "pushed"; readonly rewrote: boolean }
  | { readonly kind: "error"; readonly message: string };

export const clipError = (text: string) => {
  const flat = text.trim();
  return flat.length > ERROR_MAX_CHARS ? `…${flat.slice(flat.length - ERROR_MAX_CHARS)}` : flat;
};

/** Never fails: a git that cannot run is a failed step, which the land queue records. */
export const makeLandGit = (git: Git) => {
  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
  ) =>
    git
      .execute({
        operation: `CaptainLand.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
        ...(options.env === undefined ? {} : { env: options.env }),
      })
      .pipe(
        Effect.map((result) => ({
          ok: result.exitCode === 0,
          code: Number(result.exitCode),
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        })),
        Effect.catch((error) =>
          Effect.succeed({ ok: false, code: -1, stdout: "", stderr: error.message }),
        ),
      );

  const revision = Effect.fn("CaptainLand.revision")(function* (cwd: string, rev: string) {
    const result = yield* run("revision", cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${rev}^{commit}`,
    ]);
    return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
  });

  const isAncestor = Effect.fn("CaptainLand.isAncestor")(function* (
    cwd: string,
    ancestor: string,
    descendant: string,
  ) {
    return (yield* run("isAncestor", cwd, ["merge-base", "--is-ancestor", ancestor, descendant]))
      .ok;
  });

  const currentBranch = Effect.fn("CaptainLand.currentBranch")(function* (cwd: string) {
    const result = yield* run("currentBranch", cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
  });

  const isClean = Effect.fn("CaptainLand.isClean")(function* (cwd: string) {
    const result = yield* run("isClean", cwd, ["status", "--porcelain"]);
    return result.ok && result.stdout.length === 0;
  });

  const hasLocalBranch = Effect.fn("CaptainLand.hasLocalBranch")(function* (
    cwd: string,
    name: string,
  ) {
    return (yield* run("hasLocalBranch", cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ])).ok;
  });

  const baseBranch = Effect.fn("CaptainLand.baseBranch")(function* (cwd: string) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.option);
    const remoteDefault =
      remote._tag === "None"
        ? null
        : yield* git
            .resolveDefaultBranchName(cwd, remote.value)
            .pipe(Effect.orElseSucceed(() => null));
    for (const candidate of [remoteDefault, "main", "master"]) {
      if (candidate !== null && (yield* hasLocalBranch(cwd, candidate))) return candidate;
    }
    return yield* currentBranch(cwd);
  });

  const rebaseOnto = Effect.fn("CaptainLand.rebaseOnto")(function* (cwd: string, onto: string) {
    if (yield* isAncestor(cwd, onto, "HEAD")) return { kind: "up_to_date" } satisfies RebaseOutcome;
    const result = yield* run("rebase", cwd, ["rebase", onto], {
      env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    });
    if (result.ok) return { kind: "rebased" } satisfies RebaseOutcome;
    const unmerged = yield* run("unmergedFiles", cwd, ["diff", "--name-only", "--diff-filter=U"]);
    const files = unmerged.stdout.split("\n").filter((line) => line.length > 0);
    yield* run("rebaseAbort", cwd, ["rebase", "--abort"]);
    return files.length > 0
      ? ({ kind: "conflict", files } satisfies RebaseOutcome)
      : ({
          kind: "error",
          message: clipError(result.stderr || result.stdout || "git rebase failed"),
        } satisfies RebaseOutcome);
  });

  const remoteBranchSha = Effect.fn("CaptainLand.remoteBranchSha")(function* (
    cwd: string,
    remote: string,
    branch: string,
  ) {
    const result = yield* run(
      "lsRemote",
      cwd,
      ["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`],
      { timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (!result.ok) {
      return { error: clipError(result.stderr || "git ls-remote failed") } as const;
    }
    const [sha] = result.stdout.split(/\s+/);
    return { sha: sha === undefined || sha.length === 0 ? undefined : sha } as const;
  });

  /** A rebased branch is rewritten under a lease on the value just read; anything else only moves forward. */
  const pushBranch = Effect.fn("CaptainLand.pushBranch")(function* (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly branch: string;
  }) {
    const { cwd, remote, branch } = input;
    const local = yield* revision(cwd, `refs/heads/${branch}`);
    if (local === undefined) {
      return {
        kind: "error",
        message: `The branch ${branch} does not exist.`,
      } satisfies PushOutcome;
    }
    const remoteState = yield* remoteBranchSha(cwd, remote, branch);
    if ("error" in remoteState) {
      return { kind: "error", message: remoteState.error } satisfies PushOutcome;
    }
    if (remoteState.sha === local) return { kind: "up_to_date" } satisfies PushOutcome;
    const rewrote =
      remoteState.sha !== undefined && !(yield* isAncestor(cwd, remoteState.sha, local));
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const result = yield* run(
      "push",
      cwd,
      [
        "push",
        ...(rewrote ? [`--force-with-lease=refs/heads/${branch}:${remoteState.sha}`] : []),
        "--",
        remote,
        refspec,
      ],
      { env: LAND_QUEUE_ENV, timeoutMs: PUSH_TIMEOUT_MS },
    );
    return result.ok
      ? ({ kind: "pushed", rewrote } satisfies PushOutcome)
      : ({
          kind: "error",
          message: clipError(result.stderr || result.stdout || "git push failed"),
        } satisfies PushOutcome);
  });

  /** The checkout moves too only when it is on `base` with a clean tree; otherwise just the ref does. */
  const fastForwardBase = Effect.fn("CaptainLand.fastForwardBase")(function* (input: {
    readonly cwd: string;
    readonly base: string;
    readonly branchSha: string;
  }) {
    const { cwd, base, branchSha } = input;
    const baseSha = yield* revision(cwd, `refs/heads/${base}`);
    if (baseSha === undefined) {
      return {
        kind: "error",
        message: `The base branch ${base} does not exist.`,
      } satisfies FastForwardOutcome;
    }
    if (baseSha === branchSha || (yield* isAncestor(cwd, branchSha, baseSha))) {
      return { kind: "already_there" } satisfies FastForwardOutcome;
    }
    if (!(yield* isAncestor(cwd, baseSha, branchSha))) {
      return { kind: "base_moved" } satisfies FastForwardOutcome;
    }
    const current = yield* currentBranch(cwd);
    const clean = yield* isClean(cwd);
    if (current === base && clean) {
      const merged = yield* run("mergeFastForward", cwd, ["merge", "--ff-only", branchSha]);
      if (merged.ok) return { kind: "checkout" } satisfies FastForwardOutcome;
      return {
        kind: "error",
        message: clipError(merged.stderr || merged.stdout || "git merge --ff-only failed"),
      } satisfies FastForwardOutcome;
    }
    const moved = yield* run("updateRef", cwd, [
      "update-ref",
      "-m",
      "baton: land crew branch",
      `refs/heads/${base}`,
      branchSha,
      baseSha,
    ]);
    if (!moved.ok) {
      return {
        kind: "error",
        message: clipError(moved.stderr || "git update-ref failed"),
      } satisfies FastForwardOutcome;
    }
    return {
      kind: "ref",
      reason:
        current === base
          ? "the checkout has uncommitted changes"
          : current === undefined
            ? "the checkout is on a detached HEAD"
            : `the checkout is on ${current}`,
    } satisfies FastForwardOutcome;
  });

  return {
    run,
    revision,
    isAncestor,
    currentBranch,
    isClean,
    baseBranch,
    rebaseOnto,
    pushBranch,
    fastForwardBase,
  };
};

export type LandGit = ReturnType<typeof makeLandGit>;
