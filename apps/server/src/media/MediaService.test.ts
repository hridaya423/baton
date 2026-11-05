import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MediaService from "./MediaService.ts";

const PROJECT_ID = ProjectId.make("project-1");
const SCOPE = { projectId: PROJECT_ID, threadId: "thread-1" };
const DAY = "1970-01-01";
const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const PNG_BASE64 = Buffer.from(PNG).toString("base64");

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
  readonly form: FormData | undefined;
}

const record = (request: HttpClientRequest.HttpClientRequest): Recorded => ({
  method: request.method,
  url: request.url,
  headers: request.headers,
  json:
    request.body._tag === "Uint8Array"
      ? JSON.parse(new TextDecoder().decode(request.body.body))
      : undefined,
  form: request.body._tag === "FormData" ? request.body.formData : undefined,
});

type Settings = NonNullable<Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0]>;

const harness = (
  dir: string,
  options: {
    readonly script: (request: Recorded) => Response | undefined;
    readonly settings?: Settings["media"];
    readonly env?: Record<string, string>;
    readonly secret?: string;
  },
) => {
  const requests: Recorded[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const recorded = record(request);
      requests.push(recorded);
      return HttpClientResponse.fromWeb(
        request,
        options.script(recorded) ?? new Response("not found", { status: 404 }),
      );
    }),
  );
  const layer = MediaService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(HttpClient.HttpClient, http),
        ServerSettings.ServerSettingsService.layerTest({ media: options.settings ?? {} }),
        Layer.mock(SecretResolver.SecretResolver)({
          read: (references) => Effect.succeed(references.map(() => options.secret)),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: dir } as never),
        }),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} })),
      ),
    ),
  );
  return { requests, layer };
};

const sidecar = Effect.fn("MediaService.test.sidecar")(function* (dir: string, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return JSON.parse(
    yield* fs.readFileString(path.join(dir, ".baton", "media", DAY, `${id}.json`)),
  ) as Record<string, unknown>;
});

const tempProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-" });
  yield* fs.makeDirectory(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
});

const openAiImages = (usage?: object) =>
  Response.json({ data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }], usage });

const test = <A, E>(
  name: string,
  body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => it.effect(name, () => body.pipe(Effect.provide(NodeServices.layer)));

describe("MediaService", () => {
  test(
    "OpenAI generate posts JSON, takes its key from the environment, and prices from usage",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const { requests, layer } = harness(dir, {
        env: { OPENAI_API_KEY: "env-openai" },
        script: ({ url }) =>
          url.endsWith("/images/generations")
            ? openAiImages({
                input_tokens: 100,
                output_tokens: 1000,
                input_tokens_details: { text_tokens: 100, image_tokens: 0 },
              })
            : undefined,
      });
      const result = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        return yield* media.generateImage({
          ...SCOPE,
          prompt: "a lighthouse",
          model: "gpt-image-1",
          size: "1536x1024",
          count: 2,
        });
      }).pipe(Effect.provide(layer));

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, "https://api.openai.com/v1/images/generations");
      assert.strictEqual(requests[0]?.headers.authorization, "Bearer env-openai");
      assert.deepStrictEqual(requests[0]?.json, {
        model: "gpt-image-1",
        prompt: "a lighthouse",
        n: 2,
        size: "1536x1024",
      });
      assert.strictEqual(result.paths.length, 2);
      assert.deepStrictEqual(result.cost, { usd: 0.0405, estimated: false });
      assert.isDefined(result.preview);
      const stored = yield* sidecar(dir, result.id);
      assert.strictEqual(stored.threadId, "thread-1");
      assert.strictEqual(stored.backend, "openai");
      assert.strictEqual(stored.status, "complete");
    }),
  );

  test(
    "OpenAI default model is the newest gpt-image the API lists",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const { requests, layer } = harness(dir, {
        settings: { openaiApiKey: "saved-openai" },
        script: ({ url }) =>
          url.endsWith("/v1/models")
            ? Response.json({
                data: [
                  { id: "gpt-image-1", created: 10 },
                  { id: "gpt-image-2", created: 30 },
                  { id: "gpt-image-2-2026-01-01", created: 40 },
                  { id: "gpt-6", created: 50 },
                ],
              })
            : url.endsWith("/images/generations")
              ? openAiImages()
              : undefined,
      });
      const result = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        return yield* media.generateImage({ ...SCOPE, prompt: "x" });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(result.model, "gpt-image-2");
      assert.deepStrictEqual(requests[1]?.json, { model: "gpt-image-2", prompt: "x", n: 1 });
      assert.strictEqual(result.cost?.estimated, true);
    }),
  );

  test(
    "OpenAI edit and reference-image generation post multipart to the edits endpoint",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempProject;
      yield* fs.writeFile(path.join(dir, "a.png"), PNG);
      yield* fs.writeFile(path.join(dir, "b.jpg"), PNG);
      yield* fs.writeFile(path.join(dir, "mask.png"), PNG);
      const { requests, layer } = harness(dir, {
        settings: { openaiApiKey: "saved-openai" },
        script: ({ url }) => (url.endsWith("/images/edits") ? openAiImages() : undefined),
      });
      yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        yield* media.editImage({
          ...SCOPE,
          image: path.join(dir, "a.png"),
          prompt: "warmer",
          mask: path.join(dir, "mask.png"),
          model: "gpt-image-1",
        });
        yield* media.generateImage({
          ...SCOPE,
          prompt: "blend",
          model: "gpt-image-1",
          referenceImages: [path.join(dir, "a.png"), path.join(dir, "b.jpg")],
        });
      }).pipe(Effect.provide(layer));

      const [edit, blend] = requests;
      assert.strictEqual(edit?.url, "https://api.openai.com/v1/images/edits");
      assert.strictEqual(edit?.form?.get("prompt"), "warmer");
      assert.strictEqual(edit?.form?.get("model"), "gpt-image-1");
      assert.strictEqual(edit?.form?.getAll("image[]").length, 1);
      assert.strictEqual((edit?.form?.get("mask") as File | null)?.name, "mask.png");
      assert.strictEqual(blend?.url, "https://api.openai.com/v1/images/edits");
      assert.deepStrictEqual(
        (blend?.form?.getAll("image[]") ?? []).map((file) => (file as File).type),
        ["image/png", "image/jpeg"],
      );
    }),
  );

  test(
    "Gemini generate posts parts with the key header and prices from tokens",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const { requests, layer } = harness(dir, {
        settings: { geminiApiKey: "saved-gemini" },
        script: ({ url }) =>
          url.includes(":generateContent")
            ? Response.json({
                candidates: [
                  {
                    content: {
                      parts: [{ inlineData: { mimeType: "image/png", data: PNG_BASE64 } }],
                    },
                  },
                ],
                usageMetadata: { candidatesTokenCount: 1290 },
              })
            : undefined,
      });
      const result = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        return yield* media.generateImage({
          ...SCOPE,
          prompt: "a fox",
          model: "gemini-2.5-flash-image",
          size: "16:9",
        });
      }).pipe(Effect.provide(layer));

      assert.strictEqual(
        requests[0]?.url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
      );
      assert.strictEqual(requests[0]?.headers["x-goog-api-key"], "saved-gemini");
      assert.deepStrictEqual(requests[0]?.json, {
        contents: [{ parts: [{ text: "a fox" }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
      });
      assert.deepStrictEqual(result.cost, { usd: 0.0387, estimated: false });
      assert.strictEqual(result.backend, "gemini");
    }),
  );

  const falScript =
    (state: { statusCalls: number; completeAfter: number; onFirstStatus?: () => void }) =>
    (request: Recorded) => {
      const { url, method } = request;
      if (method === "POST" && url.startsWith("https://queue.fal.run/")) {
        return Response.json({
          request_id: "r1",
          status_url: "https://queue.fal.run/fal-ai/bytedance/requests/r1/status",
          response_url: "https://queue.fal.run/fal-ai/bytedance/requests/r1",
        });
      }
      if (url.endsWith("/r1/status")) {
        state.statusCalls += 1;
        if (state.statusCalls === 1) state.onFirstStatus?.();
        return Response.json({
          status: state.statusCalls > state.completeAfter ? "COMPLETED" : "IN_QUEUE",
        });
      }
      if (url.endsWith("/requests/r1")) {
        return Response.json({ video: { url: "https://cdn.fal.test/v.mp4" }, seed: 7 });
      }
      return url === "https://cdn.fal.test/v.mp4"
        ? new Response(Uint8Array.of(0, 0, 0, 24))
        : undefined;
    };

  test(
    "fal submits, polls, and saves the finished video from a secret reference",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempProject;
      yield* fs.writeFile(path.join(dir, "still.png"), PNG);
      const polled = yield* Deferred.make<void>();
      const state = {
        statusCalls: 0,
        completeAfter: 1,
        onFirstStatus: () => Deferred.doneUnsafe(polled, Effect.void),
      };
      const { requests, layer } = harness(dir, {
        settings: {
          falApiKey: { provider: SecretProviderId.make("onepassword"), reference: "op://v/fal" },
        },
        secret: "fal-secret",
        script: falScript(state),
      });
      const result = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const running = yield* media
          .generateVideo({
            ...SCOPE,
            prompt: "slow push in",
            image: path.join(dir, "still.png"),
            durationSeconds: 5,
            aspectRatio: "16:9",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(polled);
        yield* TestClock.adjust("1 minute");
        return yield* Fiber.join(running);
      }).pipe(Effect.provide(layer));

      const submit = requests[0];
      assert.strictEqual(
        submit?.url,
        "https://queue.fal.run/fal-ai/bytedance/seedance/v1/pro/image-to-video",
      );
      assert.strictEqual(submit?.headers.authorization, "Key fal-secret");
      assert.deepStrictEqual(submit?.json, {
        prompt: "slow push in",
        image_url: `data:image/png;base64,${PNG_BASE64}`,
        duration: "5",
        aspect_ratio: "16:9",
      });
      assert.strictEqual(state.statusCalls, 2);
      assert.strictEqual(result.status, "complete");
      assert.strictEqual(result.seed, 7);
      assert.deepStrictEqual(result.cost, { usd: 0.6, estimated: true });
      assert.deepStrictEqual([...(yield* fs.readFile(result.paths[0] ?? ""))], [0, 0, 0, 24]);
      const stored = yield* sidecar(dir, result.id);
      assert.strictEqual(stored.status, "complete");
      assert.isUndefined(stored.job);
    }),
  );

  test(
    "fal returns pending after the poll cap, and media_get finishes it later",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const polled = yield* Deferred.make<void>();
      const state = {
        statusCalls: 0,
        completeAfter: Number.POSITIVE_INFINITY,
        onFirstStatus: () => Deferred.doneUnsafe(polled, Effect.void),
      };
      const { layer } = harness(dir, {
        settings: { falApiKey: "saved-fal" },
        script: falScript(state),
      });
      yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const running = yield* media
          .generateVideo({ ...SCOPE, prompt: "waves", model: "kling" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(polled);
        yield* TestClock.adjust("11 minutes");
        const pending = yield* Fiber.join(running);
        assert.strictEqual(pending.status, "pending");
        assert.deepStrictEqual(pending.paths, []);
        assert.strictEqual((yield* sidecar(dir, pending.id)).status, "pending");

        const stillRunning = yield* media.get({ projectId: PROJECT_ID, id: pending.id });
        assert.strictEqual(stillRunning.status, "pending");

        state.completeAfter = 0;
        const finished = yield* media.get({ projectId: PROJECT_ID, id: pending.id });
        assert.strictEqual(finished.status, "complete");
        assert.lengthOf(finished.paths, 1);
        assert.strictEqual((yield* sidecar(dir, pending.id)).status, "complete");
      }).pipe(Effect.provide(layer));
    }),
  );

  test(
    "a call that would pass the daily cap is refused before any request",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const { requests, layer } = harness(dir, {
        settings: { openaiApiKey: "saved-openai", dailySpendCapUsd: 0.1 },
        script: () => openAiImages(),
      });
      const error = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        return yield* media
          .generateImage({ ...SCOPE, prompt: "x", model: "gpt-image-1" })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(error._tag, "MediaSpendCapError");
      assert.include(error.message, "$0.10");
      assert.include(error.message, "Settings → Media");
      assert.lengthOf(requests, 0);
    }),
  );

  test(
    "records are listed newest first, filtered by kind, and the folder is git-excluded",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempProject;
      const state = { statusCalls: 0, completeAfter: 0 };
      const { layer } = harness(dir, {
        settings: { openaiApiKey: "saved-openai", falApiKey: "saved-fal", dailySpendCapUsd: 50 },
        script: (request) =>
          falScript(state)(request) ??
          (request.url.endsWith("/generations") ? openAiImages() : undefined),
      });
      yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const first = yield* media.generateImage({ ...SCOPE, prompt: "one", model: "gpt-image-1" });
        yield* TestClock.adjust("1 second");
        const video = yield* media.generateVideo({ ...SCOPE, prompt: "two" });
        yield* TestClock.adjust("1 second");
        yield* media.generateImage({ ...SCOPE, prompt: "three", model: "gpt-image-1" });
        yield* TestClock.adjust("1 second");
        yield* media.generateImage({ ...SCOPE, prompt: "four", model: "gpt-image-1" });

        const all = yield* media.list({ projectId: PROJECT_ID });
        assert.deepStrictEqual(all.map((entry) => entry.prompt).slice(0, 3), [
          "four",
          "three",
          "two",
        ]);
        const videos = yield* media.list({ projectId: PROJECT_ID, kind: "video" });
        assert.deepStrictEqual(
          videos.map((entry) => entry.id),
          [video.id],
        );
        const limited = yield* media.list({ projectId: PROJECT_ID, limit: 1 });
        assert.lengthOf(limited, 1);
        assert.strictEqual(
          (yield* media.get({ projectId: PROJECT_ID, id: first.id })).prompt,
          "one",
        );
        const missing = yield* media
          .get({ projectId: PROJECT_ID, id: "../../etc/passwd" })
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "MediaNotFoundError");
      }).pipe(Effect.provide(layer));
      const exclude = yield* fs.readFileString(path.join(dir, ".git", "info", "exclude"));
      assert.strictEqual(exclude.split("\n").filter((line) => line === ".baton/").length, 1);
    }),
  );

  test(
    "a call with no key for the backend fails with one sentence and sends nothing",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const { requests, layer } = harness(dir, { script: () => openAiImages() });
      const error = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        return yield* media.generateImage({ ...SCOPE, prompt: "x" }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(error.message, "No image key. Add one in Settings → Media.");
      assert.lengthOf(requests, 0);
    }),
  );

  test(
    "a secret reference that cannot be read fails instead of passing for a missing key",
    Effect.gen(function* () {
      const dir = yield* tempProject;
      const { requests, layer } = harness(dir, {
        settings: {
          openaiApiKey: { provider: SecretProviderId.make("onepassword"), reference: "op://v/o" },
        },
        env: { OPENAI_API_KEY: "env-openai" },
        script: () => openAiImages(),
      });
      const error = yield* Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        return yield* media
          .generateImage({ ...SCOPE, prompt: "x", model: "gpt-image-1" })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
      assert.lengthOf(requests, 0);
    }),
  );
});
