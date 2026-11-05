import type { CaptainVerifyResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

const LOG_TAIL_BYTES = 4 * 1024;

const shellInvocation = (cmd: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `${cmd} 2>&1`] }
    : { command: "/bin/sh", args: ["-c", `exec 2>&1; ${cmd}`] };

export const tailBytes = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  return `…${bytes
    .subarray(bytes.byteLength - maxBytes)
    .toString("utf8")
    .replace(/^�+/, "")}`;
};

const iso = Effect.map(Clock.currentTimeMillis, (ms) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)),
);

/** Never fails: a command that cannot run is a failed check with the reason in its log. */
export const runDoneCheck = Effect.fn("Verifier.runDoneCheck")(function* (input: {
  readonly cmd: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const startedAt = yield* iso;
  const { command, args } = shellInvocation(
    input.cmd,
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );
  const ran = yield* runner
    .run({
      command,
      args,
      cwd: input.cwd,
      timeout: input.timeoutMs,
      env: { CI: "1" },
      outputMode: "truncate",
      maxOutputBytes: 1024 * 1024,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.result);
  const finishedAt = yield* iso;
  if (ran._tag === "Failure") {
    return {
      cmd: input.cmd,
      exit: null,
      logTail: tailBytes(`Could not run the check: ${ran.failure.message}`, LOG_TAIL_BYTES),
      startedAt,
      finishedAt,
    } satisfies CaptainVerifyResult;
  }
  const output = ran.success;
  const minutes = Math.round(input.timeoutMs / 60_000);
  return {
    cmd: input.cmd,
    exit: output.timedOut ? null : output.code,
    logTail: output.timedOut
      ? `Timed out after ${minutes} minute${minutes === 1 ? "" : "s"}.`
      : tailBytes(`${output.stdout}${output.stderr}`, LOG_TAIL_BYTES),
    startedAt,
    finishedAt,
  } satisfies CaptainVerifyResult;
});
