import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "post-rewrite",
  "post-index-change",
  "reference-transaction",
] as const;

const PROTECTED_BRANCHES = ["main", "master"];

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * One script serves every hook name. It refuses base-branch pushes, force pushes and tag pushes,
 * then hands the call to the repository's own hook of the same name, which `core.hooksPath` would
 * otherwise hide.
 */
const crewHookScript = (input: {
  readonly baseBranch: string | undefined;
  readonly repoHooksPath: string | undefined;
}) => {
  const protectedRefs = [
    ...new Set([
      ...PROTECTED_BRANCHES,
      ...(input.baseBranch === undefined ? [] : [input.baseBranch]),
    ]),
  ].map((branch) => `refs/heads/${branch}`);
  return `#!/bin/sh
name=$(basename "$0")
repo_hooks_path=${shellQuote(input.repoHooksPath ?? "")}

refuse() {
  echo "Baton refused this push: $1." >&2
  exit 1
}

repo_hook() {
  if [ -n "$repo_hooks_path" ]; then
    dir="$repo_hooks_path"
  else
    dir="$(git rev-parse --git-common-dir)/hooks"
  fi
  hook="$dir/$name"
  if [ -x "$hook" ]; then
    echo "$hook"
  fi
}

if [ "$name" != "pre-push" ]; then
  hook=$(repo_hook)
  if [ -n "$hook" ]; then
    exec "$hook" "$@"
  fi
  exit 0
fi

input=$(cat)
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$remote_ref" ] || continue
  case "$remote_ref" in
    refs/tags/*) refuse "tag pushes are not allowed from a crew worktree" ;;
  esac
  for protected in ${protectedRefs.map(shellQuote).join(" ")}; do
    if [ "$remote_ref" = "$protected" ]; then
      refuse "pushes to \${protected#refs/heads/} are not allowed from a crew worktree"
    fi
  done
  case "$remote_sha" in *[!0]*) ;; *) continue ;; esac
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    if [ "$BATON_LAND_QUEUE" = "1" ]; then
      case "$remote_ref" in refs/heads/crew/*/*) continue ;; esac
    fi
    refuse "force pushes are not allowed from a crew worktree"
  fi
done <<EOF
$input
EOF

hook=$(repo_hook)
if [ -n "$hook" ]; then
  printf '%s\\n' "$input" | "$hook" "$@"
  exit $?
fi
exit 0
`;
};

const gitValue = (git: GitVcsDriver.GitVcsDriver["Service"], cwd: string, args: string[]) =>
  git
    .execute({
      operation: "CrewHooks.read",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );

/**
 * Points the crew worktree, and only it, at a hooks directory of ours. Needs
 * `extensions.worktreeConfig`, which git itself turns on for sparse checkouts in worktrees; it makes
 * git read `config.worktree` and changes nothing else in the repository.
 */
export const installCrewHooks = Effect.fn("CrewHooks.install")(function* (input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly hooksDir: string;
  readonly projectCwd: string;
  readonly worktreePath: string;
  readonly baseBranch: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { git, projectCwd } = input;
  const repoHooksPath = (yield* gitValue(git, projectCwd, ["config", "--get", "core.hooksPath"]))
    .split("\n")[0]
    ?.trim();
  const script = crewHookScript({
    baseBranch: input.baseBranch,
    repoHooksPath:
      repoHooksPath === undefined || repoHooksPath.length === 0 ? undefined : repoHooksPath,
  });
  yield* fileSystem.makeDirectory(input.hooksDir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = path.join(input.hooksDir, name);
    const current = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (current !== script) {
      yield* fileSystem.writeFileString(file, script, { mode: 0o755 });
      yield* fileSystem.chmod(file, 0o755);
    }
  }
  if (
    (yield* gitValue(git, projectCwd, ["config", "--get", "extensions.worktreeConfig"])) !== "true"
  ) {
    yield* git.execute({
      operation: "CrewHooks.enableWorktreeConfig",
      cwd: projectCwd,
      args: ["config", "extensions.worktreeConfig", "true"],
      writesSharedConfig: true,
      timeoutMs: 10_000,
    });
  }
  yield* git.execute({
    operation: "CrewHooks.setHooksPath",
    cwd: input.worktreePath,
    args: ["config", "--worktree", "core.hooksPath", input.hooksDir],
    timeoutMs: 10_000,
  });
});
