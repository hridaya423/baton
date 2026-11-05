import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureBatonExcluded } from "./batonExclude.ts";

it.layer(NodeServices.layer)("ensureBatonExcluded", (it) => {
  it.effect("adds .baton/ once to a repository's exclude file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.makeDirectory(path.join(root, ".git", "info"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, ".git", "info", "exclude"), "notes.txt");
      yield* fileSystem.makeDirectory(path.join(root, "src"));
      yield* ensureBatonExcluded(path.join(root, "src"));
      yield* ensureBatonExcluded(root);
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, ".git", "info", "exclude")),
        "notes.txt\n.baton/\n",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("writes a linked worktree's entry to its main checkout's exclude file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const gitDir = path.join(root, "main", ".git");
      const worktreeGitDir = path.join(gitDir, "worktrees", "wt");
      yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
      const worktree = path.join(root, "wt");
      yield* fileSystem.makeDirectory(worktree);
      yield* fileSystem.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      yield* ensureBatonExcluded(worktree);
      assert.equal(
        yield* fileSystem.readFileString(path.join(gitDir, "info", "exclude")),
        ".baton/\n",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing outside a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      yield* ensureBatonExcluded(root);
      assert.deepEqual(yield* fileSystem.readDirectory(root), []);
    }).pipe(Effect.scoped),
  );
});
