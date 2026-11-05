import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const BATON_ENTRY = ".baton/";

/**
 * Adds `.baton/` to the repository's `.git/info/exclude`, not `.gitignore`, so what agents write
 * there never shows as a change. A linked worktree shares its main checkout's exclude file.
 * Outside a repository it does nothing.
 */
export const ensureBatonExcluded = Effect.fn("batonExclude.ensure")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findGitEntry = Effect.fn("batonExclude.findGitEntry")(function* (start: string) {
    let dir = start;
    while (true) {
      const candidate = path.join(dir, ".git");
      if (yield* fileSystem.exists(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  });

  const resolveCommonDir = Effect.fn("batonExclude.resolveCommonDir")(function* (entry: string) {
    const stat = yield* fileSystem.stat(entry);
    if (stat.type === "Directory") return entry;
    const pointer = (yield* fileSystem.readFileString(entry)).match(/^gitdir:\s*(.+)$/m)?.[1];
    if (pointer === undefined) return null;
    const gitDir = path.resolve(path.dirname(entry), pointer.trim());
    const common = yield* fileSystem
      .readFileString(path.join(gitDir, "commondir"))
      .pipe(Effect.orElseSucceed(() => "."));
    return path.resolve(gitDir, common.trim());
  });

  const entry = yield* findGitEntry(cwd);
  if (entry === null) return;
  const commonDir = yield* resolveCommonDir(entry);
  if (commonDir === null) return;
  const excludePath = path.join(commonDir, "info", "exclude");
  const current = yield* fileSystem
    .readFileString(excludePath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (current.split("\n").some((line) => line.trim() === BATON_ENTRY)) return;
  yield* fileSystem.makeDirectory(path.dirname(excludePath), { recursive: true });
  yield* fileSystem.writeFileString(
    excludePath,
    `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${BATON_ENTRY}\n`,
  );
});
