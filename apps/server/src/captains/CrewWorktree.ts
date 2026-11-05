import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { REVIEW_DIFF_MAX_BYTES } from "./captainMessages.ts";

export type ReviewDiff =
  | { readonly text: string }
  | { readonly files: string }
  | { readonly unreadable: string };

/** The diff of `range`, or its file list when it is over the review cap. Never fails. */
export const diffOfRange = Effect.fn("CrewWorktree.diffOfRange")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  range: string,
) {
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
  if (full._tag === "Failure") return { unreadable: full.failure.message } satisfies ReviewDiff;
  if (full.success.exitCode !== 0) {
    return {
      unreadable: full.success.stderr.trim().slice(0, 300) || "git diff failed",
    } satisfies ReviewDiff;
  }
  if (!full.success.stdoutTruncated) {
    return {
      text: full.success.stdout.length === 0 ? "(no changes)" : full.success.stdout,
    } satisfies ReviewDiff;
  }
  const files = yield* git
    .execute({
      operation: "CaptainService.reviewFiles",
      cwd,
      args: ["diff", "--no-color", "--name-status", range],
      allowNonZeroExit: true,
    })
    .pipe(Effect.option);
  return {
    files: Option.isSome(files) ? files.value.stdout : "(could not list the files)",
  } satisfies ReviewDiff;
});

/** A crew branch is `crew/<captain>/<order>`, which the crew push guard lets a land push rewrite. */
export const isCrewBranch = (branch: string) => /^crew\/[^/\s]+\/[^\s]+$/.test(branch);
