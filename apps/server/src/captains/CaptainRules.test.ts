import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { modelStrength, pickReviewer, type ReviewerCandidate } from "./ReviewerModels.ts";
import { holdsStall, stallLevelFor } from "./StallRules.ts";
import { runDoneCheck, tailBytes } from "./Verifier.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const candidate = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
  fields: Partial<Pick<ReviewerCandidate, "enabled" | "installed" | "status" | "auth">> = {},
): ReviewerCandidate => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: models.map((slug) => ({ slug })),
  ...fields,
});

const codexModels = ["gpt-5.4", "gpt-5.5-mini", "gpt-5.5", "gpt-5.3-codex"];
const claudeModels = ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"];

it("ranks a newer model above an older one and a mini or haiku below its sibling", () => {
  assert.isAbove(modelStrength("gpt-5.5"), modelStrength("gpt-5.4"));
  assert.isAbove(modelStrength("gpt-5.5"), modelStrength("gpt-5.5-mini"));
  assert.isAbove(modelStrength("claude-opus-5-5"), modelStrength("claude-sonnet-5-5"));
  assert.isAbove(modelStrength("claude-sonnet-5-5"), modelStrength("claude-haiku-5-5"));
  assert.isAbove(modelStrength("claude-opus-5-5"), modelStrength("claude-opus-4-1-20250805"));
});

it("reviews a Claude crew with the strongest Codex model and a Codex crew with the strongest Claude model", () => {
  const providers = [
    candidate(codex, "codex", codexModels),
    candidate(claude, "claudeAgent", claudeModels),
  ];
  const forClaudeCrew = pickReviewer({
    crew: { instanceId: claude, model: "claude-opus-5-5" },
    crewDriver: ProviderDriverKind.make("claudeAgent"),
    configured: undefined,
    providers,
  });
  assert.deepEqual(forClaudeCrew, {
    model: { instanceId: codex, model: "gpt-5.5" },
    sameProvider: false,
  });
  const forCodexCrew = pickReviewer({
    crew: { instanceId: codex, model: "gpt-5.5" },
    crewDriver: ProviderDriverKind.make("codex"),
    configured: undefined,
    providers,
  });
  assert.deepEqual(forCodexCrew, {
    model: { instanceId: claude, model: "claude-opus-5-5" },
    sameProvider: false,
  });
});

it("honours the charter's review model and says whether it shares the crew's provider", () => {
  const providers = [
    candidate(codex, "codex", codexModels),
    candidate(claude, "claudeAgent", claudeModels),
  ];
  const input = {
    crew: { instanceId: codex, model: "gpt-5.5" },
    crewDriver: ProviderDriverKind.make("codex"),
    providers,
  };
  assert.deepEqual(
    pickReviewer({ ...input, configured: { instanceId: claude, model: "claude-sonnet-5-5" } }),
    { model: { instanceId: claude, model: "claude-sonnet-5-5" }, sameProvider: false },
  );
  assert.deepEqual(
    pickReviewer({ ...input, configured: { instanceId: codex, model: "gpt-5.4" } }),
    { model: { instanceId: codex, model: "gpt-5.4" }, sameProvider: true },
  );
});

it("skips providers that are disabled, signed out or broken, then falls back to another model of the same provider", () => {
  const crew = { instanceId: codex, model: "gpt-5.5" };
  const crewDriver = ProviderDriverKind.make("codex");
  const sameProviderModels = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"];
  const picked = pickReviewer({
    crew,
    crewDriver,
    configured: undefined,
    providers: [
      candidate(codex, "codex", sameProviderModels),
      candidate(claude, "claudeAgent", claudeModels, { auth: { status: "unauthenticated" } }),
    ],
  });
  assert.deepEqual(picked, {
    model: { instanceId: codex, model: "gpt-5.4" },
    sameProvider: true,
  });
  for (const fields of [{ enabled: false }, { installed: false }, { status: "error" as const }]) {
    const skipped = pickReviewer({
      crew,
      crewDriver,
      configured: undefined,
      providers: [
        candidate(codex, "codex", sameProviderModels),
        candidate(claude, "claudeAgent", claudeModels, fields),
      ],
    });
    assert.isTrue(skipped.sameProvider);
  }
  const lone = pickReviewer({
    crew,
    crewDriver,
    configured: undefined,
    providers: [candidate(codex, "codex", ["gpt-5.5"])],
  });
  assert.deepEqual(lone, { model: crew, sameProvider: true });
});

it("counts a crew as stalled only after whole silent windows, and not while it waits on background work, a PR or a request", () => {
  const stallMs = 45 * 60_000;
  assert.equal(stallLevelFor(stallMs - 1, stallMs), 0);
  assert.equal(stallLevelFor(stallMs, stallMs), 1);
  assert.equal(stallLevelFor(2 * stallMs - 1, stallMs), 1);
  assert.equal(stallLevelFor(5 * stallMs, stallMs), 2);
  const idle = { pendingBackgroundTasks: [], pendingRuntimeRequest: null, pullRequests: [] };
  assert.isFalse(holdsStall(idle));
  assert.isTrue(holdsStall({ ...idle, pendingBackgroundTasks: [{ id: "bg" }] as never }));
  assert.isTrue(holdsStall({ ...idle, pendingRuntimeRequest: { id: "request" } as never }));
  assert.isTrue(holdsStall({ ...idle, pullRequests: [{ watch: { startedAt: "now" } }] }));
  assert.isFalse(holdsStall({ ...idle, pullRequests: [{ watch: undefined }] }));
});

const layerRunner = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const check = (cmd: string, timeoutMs = 20_000) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "captain-verify-" });
    return { cwd, result: yield* runDoneCheck({ cmd, cwd, timeoutMs }) };
  });

it.live(
  "a done-check that exits 0 passes, runs in the worktree with CI=1, and logs both streams",
  () =>
    Effect.gen(function* () {
      const { cwd, result } = yield* check('pwd; echo "CI=$CI"; echo out; echo err 1>&2');
      assert.equal(result.exit, 0);
      assert.equal(result.cmd, 'pwd; echo "CI=$CI"; echo out; echo err 1>&2');
      assert.include(result.logTail, "CI=1");
      assert.include(result.logTail, "out");
      assert.include(result.logTail, "err");
      assert.include(result.logTail.replace(/^\/private/, ""), cwd.replace(/^\/private/, ""));
      assert.isAtMost(Date.parse(result.startedAt), Date.parse(result.finishedAt));
    }).pipe(Effect.provide(layerRunner)),
);

it.live("a done-check that fails reports its exit code and only the last 4 KB of output", () =>
  Effect.gen(function* () {
    const { result } = yield* check(
      "i=0; while [ $i -lt 800 ]; do echo line-$i-xxxxxxxxxxxxxxxx; i=$((i+1)); done; exit 3",
    );
    assert.equal(result.exit, 3);
    assert.isAtMost(Buffer.byteLength(result.logTail), 4 * 1024 + 4);
    assert.include(result.logTail, "line-799-");
    assert.notInclude(result.logTail, "line-0-");
    assert.isTrue(result.logTail.startsWith("…"));
  }).pipe(Effect.provide(layerRunner)),
);

it.live("a done-check that outruns its timeout fails with no exit code", () =>
  Effect.gen(function* () {
    const { result } = yield* check("sleep 30", 300);
    assert.isNull(result.exit);
    assert.include(result.logTail, "Timed out");
  }).pipe(Effect.provide(layerRunner)),
);

it("keeps whole characters when it cuts a log to its tail", () => {
  const text = `${"é".repeat(3_000)}end`;
  const tail = tailBytes(text, 1_001);
  assert.isTrue(tail.endsWith("end"));
  assert.notInclude(tail, "�");
});
