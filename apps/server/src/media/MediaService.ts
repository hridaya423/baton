import {
  type ProjectId,
  type ServerSettingsError,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import {
  requireSettingsSecret,
  type SettingsSecretUnresolvedError,
} from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ensureBatonExcluded } from "../project/batonExclude.ts";
import {
  FAL_DEFAULT_VIDEO_MODEL,
  IMAGE_BACKEND_DEFAULTS,
  IMAGE_EXTENSION_BY_MIME,
  IMAGE_MIME_BY_EXTENSION,
  type ImageInput,
  type MediaBackend,
  type MediaCost,
  MediaRequestError,
  estimateImageUsd,
  falCompleted,
  falSubmit,
  falVideo,
  geminiImages,
  imageBackendForModel,
  isFalVideoModel,
  newestOpenAiImageModel,
  openAiImages,
  planFalVideo,
} from "./MediaBackends.ts";

const MEDIA_DIRECTORY = ".baton/media";
const VIDEO_POLL_CAP_MS = 10 * 60 * 1000;
const VIDEO_POLL_FIRST_DELAY_MS = 3_000;
const VIDEO_POLL_MAX_DELAY_MS = 20_000;
const PREVIEW_MAX_BYTES = 1_500_000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MEDIA_ID = /^media_[0-9a-f]{12}$/;
const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;

export class MediaKeyMissingError extends Schema.TaggedError<MediaKeyMissingError>()(
  "MediaKeyMissingError",
  { kind: Schema.Literals(["image", "video"]) },
) {
  override get message(): string {
    return `No ${this.kind} key. Add one in Settings → Media.`;
  }
}

export class MediaSpendCapError extends Schema.TaggedError<MediaSpendCapError>()(
  "MediaSpendCapError",
  { capUsd: Schema.Number, spentUsd: Schema.Number },
) {
  override get message(): string {
    return `Daily media spend cap of $${this.capUsd.toFixed(2)} reached for this project ($${this.spentUsd.toFixed(2)} spent today). Raise it in Settings → Media.`;
  }
}

export class MediaInputError extends Schema.TaggedError<MediaInputError>()("MediaInputError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class MediaStorageError extends Schema.TaggedError<MediaStorageError>()(
  "MediaStorageError",
  { operation: Schema.Literals(["read-image", "write", "read"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "read-image"
      ? "A source image could not be read."
      : "The project's media folder could not be used.";
  }
}

export class MediaNotFoundError extends Schema.TaggedError<MediaNotFoundError>()(
  "MediaNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `No media record ${this.id} in this project.`;
  }
}

export type MediaError =
  | MediaKeyMissingError
  | MediaSpendCapError
  | MediaInputError
  | MediaStorageError
  | MediaNotFoundError
  | MediaRequestError
  | ServerSettingsError
  | SettingsSecretUnresolvedError;

const MediaRecord = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["image", "video"]),
  status: Schema.Literals(["complete", "pending"]),
  prompt: Schema.String,
  model: Schema.String,
  backend: Schema.Literals(["openai", "gemini", "fal"]),
  seed: Schema.optional(Schema.Number),
  size: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Struct({ usd: Schema.Number, estimated: Schema.Boolean })),
  createdAt: Schema.String,
  threadId: Schema.String,
  sourceImages: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.Array(Schema.String),
  job: Schema.optional(Schema.Struct({ statusUrl: Schema.String, responseUrl: Schema.String })),
});
export type MediaRecord = typeof MediaRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(MediaRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(MediaRecord));

export interface MediaResult {
  readonly id: string;
  readonly kind: "image" | "video";
  readonly status: "complete" | "pending";
  readonly paths: ReadonlyArray<string>;
  readonly model: string;
  readonly backend: MediaBackend;
  readonly cost?: MediaCost;
  readonly seed?: number;
  readonly prompt: string;
  readonly createdAt: string;
  readonly preview?: { readonly mimeType: string; readonly data: string };
}

interface Scope {
  readonly projectId: ProjectId;
  readonly threadId: string;
}

export class MediaService extends Context.Service<
  MediaService,
  {
    readonly generateImage: (
      input: Scope & {
        readonly prompt: string;
        readonly model?: string | undefined;
        readonly size?: string | undefined;
        readonly count?: number | undefined;
        readonly referenceImages?: ReadonlyArray<string> | undefined;
      },
    ) => Effect.Effect<MediaResult, MediaError>;
    readonly editImage: (
      input: Scope & {
        readonly image: string;
        readonly prompt: string;
        readonly mask?: string | undefined;
        readonly model?: string | undefined;
      },
    ) => Effect.Effect<MediaResult, MediaError>;
    readonly generateVideo: (
      input: Scope & {
        readonly prompt: string;
        readonly image?: string | undefined;
        readonly model?: string | undefined;
        readonly durationSeconds?: number | undefined;
        readonly aspectRatio?: string | undefined;
      },
    ) => Effect.Effect<MediaResult, MediaError>;
    readonly list: (input: {
      readonly projectId: ProjectId;
      readonly kind?: "image" | "video" | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<ReadonlyArray<MediaResult>, MediaError>;
    readonly get: (input: {
      readonly projectId: ProjectId;
      readonly id: string;
    }) => Effect.Effect<MediaResult, MediaError>;
    readonly spendToday: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      { readonly day: string; readonly usd: number; readonly capUsd: number },
      MediaError
    >;
  }
>()("t3/media/MediaService") {}

const envKey = (name: string, ...fallbacks: ReadonlyArray<string>) =>
  fallbacks.reduce(
    (config, next) => config.pipe(Config.orElse(() => Config.String(next))),
    Config.String(name),
  );

const ENV_KEYS = {
  openai: envKey("OPENAI_API_KEY"),
  gemini: envKey("GEMINI_API_KEY", "GOOGLE_API_KEY"),
  fal: envKey("FAL_KEY"),
} as const;

const KEY_SETTINGS = {
  openai: "openaiApiKey",
  gemini: "geminiApiKey",
  fal: "falApiKey",
} as const;

const dayOf = (millis: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(millis));
const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const configProvider = yield* ConfigProvider.ConfigProvider;
  const provideHttp = Effect.provideService(HttpClient.HttpClient, http);

  const storage = (operation: "read-image" | "write" | "read") => (cause: unknown) =>
    new MediaStorageError({ operation, cause });

  const projectRoot = Effect.fn("MediaService.projectRoot")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(Effect.mapError(storage("read")));
    if (Option.isNone(project)) {
      return yield* new MediaInputError({ reason: "The project was not found." });
    }
    return project.value.workspaceRoot;
  });

  const findKey = Effect.fn("MediaService.findKey")(function* (backend: MediaBackend) {
    const current = yield* settings.getSettings;
    const saved: SettingsSecretValue = current.media[KEY_SETTINGS[backend]];
    if (saved !== "") return Option.some(yield* requireSettingsSecret(secrets, saved));
    return yield* ENV_KEYS[backend].pipe(
      Config.option,
      Effect.map(Option.filter((value) => value.trim() !== "")),
      Effect.orElseSucceed(Option.none),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
    );
  });

  const requireKey = Effect.fn("MediaService.requireKey")(function* (
    backend: MediaBackend,
    kind: "image" | "video",
  ) {
    const key = yield* findKey(backend);
    if (Option.isNone(key)) return yield* new MediaKeyMissingError({ kind });
    return key.value;
  });

  const mediaRoot = (root: string) => path.join(root, MEDIA_DIRECTORY);

  const readRecords = Effect.fn("MediaService.readRecords")(function* (root: string, day: string) {
    const directory = path.join(mediaRoot(root), day);
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const records: MediaRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const text = yield* fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const record = decodeRecord(text);
      if (Option.isSome(record)) records.push(record.value);
    }
    return records;
  });

  const days = Effect.fn("MediaService.days")(function* (root: string) {
    const names = yield* fs.readDirectory(mediaRoot(root)).pipe(Effect.orElseSucceed(() => []));
    return names
      .filter((name) => DAY_DIRECTORY.test(name))
      .toSorted()
      .toReversed();
  });

  const dayOfRecord = (record: MediaRecord) => record.createdAt.slice(0, 10);

  const resultOf = (root: string, record: MediaRecord): MediaResult => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    paths: record.files.map((file) => path.join(mediaRoot(root), dayOfRecord(record), file)),
    model: record.model,
    backend: record.backend,
    ...(record.cost === undefined ? {} : { cost: record.cost }),
    ...(record.seed === undefined ? {} : { seed: record.seed }),
    prompt: record.prompt,
    createdAt: record.createdAt,
  });

  const spentOn = Effect.fn("MediaService.spentOn")(function* (root: string, day: string) {
    const records = yield* readRecords(root, day);
    return records.reduce((total, record) => total + (record.cost?.usd ?? 0), 0);
  });

  const spendToday: MediaService["Service"]["spendToday"] = Effect.fn("MediaService.spendToday")(
    function* ({ projectId }) {
      const root = yield* projectRoot(projectId);
      const day = dayOf(yield* Clock.currentTimeMillis);
      const current = yield* settings.getSettings;
      return { day, usd: yield* spentOn(root, day), capUsd: current.media.dailySpendCapUsd };
    },
  );

  const assertWithinCap = Effect.fn("MediaService.assertWithinCap")(function* (
    projectId: ProjectId,
    estimateUsd: number | undefined,
  ) {
    const { usd: spentUsd, capUsd } = yield* spendToday({ projectId });
    const projected = spentUsd + (estimateUsd ?? 0);
    if (projected > capUsd || (estimateUsd === undefined && spentUsd >= capUsd)) {
      return yield* new MediaSpendCapError({ capUsd, spentUsd });
    }
  });

  const newId = Effect.fn("MediaService.newId")(function* () {
    return `media_${(yield* random.uuidV4()).replaceAll("-", "").slice(0, 12)}`;
  });

  const writeRecord = Effect.fn("MediaService.writeRecord")(
    function* (
      root: string,
      record: MediaRecord,
      files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
    ) {
      const directory = path.join(mediaRoot(root), dayOfRecord(record));
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* ensureBatonExcluded(root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.ignore,
      );
      for (const file of files) yield* fs.writeFile(path.join(directory, file.name), file.bytes);
      yield* fs.writeFileString(path.join(directory, `${record.id}.json`), encodeRecord(record));
    },
    Effect.mapError(storage("write")),
  );

  const readSourceImage = Effect.fn("MediaService.readSourceImage")(function* (file: string) {
    const mimeType = IMAGE_MIME_BY_EXTENSION[path.extname(file).toLowerCase()];
    if (!path.isAbsolute(file) || mimeType === undefined) {
      return yield* new MediaInputError({
        reason: `${file} is not an absolute path to a png, jpeg or webp image.`,
      });
    }
    const bytes = yield* fs.readFile(file).pipe(Effect.mapError(storage("read-image")));
    return { bytes, mimeType, name: path.basename(file) } satisfies ImageInput;
  });

  const previewOf = (
    images: ReadonlyArray<{ readonly bytes: Uint8Array; readonly mimeType: string }>,
  ) => {
    const first = images[0];
    return first === undefined || first.bytes.byteLength > PREVIEW_MAX_BYTES
      ? {}
      : {
          preview: {
            mimeType: first.mimeType,
            data: Buffer.from(first.bytes).toString("base64"),
          },
        };
  };

  const pickImageBackend = Effect.fn("MediaService.pickImageBackend")(function* (
    requested: string | undefined,
  ) {
    const named = requested === undefined ? undefined : imageBackendForModel(requested);
    if (named !== undefined) {
      return { backend: named, apiKey: yield* requireKey(named, "image") };
    }
    for (const candidate of ["openai", "gemini"] as const) {
      const key = yield* findKey(candidate);
      if (Option.isSome(key)) return { backend: candidate, apiKey: key.value };
    }
    return yield* new MediaKeyMissingError({ kind: "image" });
  });

  const makeImages = Effect.fn("MediaService.makeImages")(function* (input: {
    readonly scope: Scope;
    readonly prompt: string;
    readonly model: string | undefined;
    readonly size: string | undefined;
    readonly count: number;
    readonly images: ReadonlyArray<ImageInput>;
    readonly mask?: ImageInput | undefined;
    readonly sourceImages: ReadonlyArray<string>;
  }) {
    const root = yield* projectRoot(input.scope.projectId);
    const { backend, apiKey } = yield* pickImageBackend(input.model);
    if (input.mask !== undefined && backend === "gemini") {
      return yield* new MediaInputError({ reason: "Gemini edits do not take a mask." });
    }
    const model =
      input.model ??
      (backend === "openai"
        ? yield* newestOpenAiImageModel(apiKey)
        : IMAGE_BACKEND_DEFAULTS.gemini);
    yield* assertWithinCap(input.scope.projectId, estimateImageUsd(backend, model, input.count));
    const generated =
      backend === "openai"
        ? yield* openAiImages({
            apiKey,
            model,
            prompt: input.prompt,
            count: input.count,
            size: input.size,
            images: input.images,
            mask: input.mask,
          })
        : yield* geminiImages({
            apiKey,
            model,
            prompt: input.prompt,
            count: input.count,
            size: input.size,
            images: input.images,
          });
    const id = yield* newId();
    const createdAt = isoOf(yield* Clock.currentTimeMillis);
    const files = generated.images.map((image, index) => ({
      name: `${index === 0 ? id : `${id}-${index + 1}`}.${IMAGE_EXTENSION_BY_MIME[image.mimeType] ?? "png"}`,
      bytes: image.bytes,
    }));
    const record: MediaRecord = {
      id,
      kind: "image",
      status: "complete",
      prompt: input.prompt,
      model,
      backend,
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(generated.cost === undefined ? {} : { cost: generated.cost }),
      createdAt,
      threadId: input.scope.threadId,
      ...(input.sourceImages.length === 0 ? {} : { sourceImages: input.sourceImages }),
      files: files.map((file) => file.name),
    };
    yield* writeRecord(root, record, files);
    return { ...resultOf(root, record), ...previewOf(generated.images) } satisfies MediaResult;
  });

  const generateImage = Effect.fn("MediaService.generateImage")(function* (
    input: Parameters<MediaService["Service"]["generateImage"]>[0],
  ) {
    const images = yield* Effect.forEach(input.referenceImages ?? [], readSourceImage);
    return yield* makeImages({
      scope: input,
      prompt: input.prompt,
      model: input.model,
      size: input.size,
      count: input.count ?? 1,
      images,
      sourceImages: input.referenceImages ?? [],
    });
  }, provideHttp);

  const editImage = Effect.fn("MediaService.editImage")(function* (
    input: Parameters<MediaService["Service"]["editImage"]>[0],
  ) {
    const image = yield* readSourceImage(input.image);
    const mask = input.mask === undefined ? undefined : yield* readSourceImage(input.mask);
    return yield* makeImages({
      scope: input,
      prompt: input.prompt,
      model: input.model,
      size: undefined,
      count: 1,
      images: [image],
      mask,
      sourceImages: [input.image],
    });
  }, provideHttp);

  const finishVideo = Effect.fn("MediaService.finishVideo")(function* (input: {
    readonly root: string;
    readonly apiKey: string;
    readonly record: MediaRecord;
  }) {
    const { job } = input.record;
    if (job === undefined) return input.record;
    const video = yield* falVideo({ apiKey: input.apiKey, job });
    const { job: _job, ...rest } = input.record;
    const settled: MediaRecord = {
      ...rest,
      status: "complete",
      files: [`${input.record.id}.mp4`],
      ...(video.seed === undefined ? {} : { seed: video.seed }),
    };
    yield* writeRecord(input.root, settled, [
      { name: `${input.record.id}.mp4`, bytes: video.bytes },
    ]);
    return settled;
  });

  const generateVideo = Effect.fn("MediaService.generateVideo")(function* (
    input: Parameters<MediaService["Service"]["generateVideo"]>[0],
  ) {
    const model = input.model ?? FAL_DEFAULT_VIDEO_MODEL;
    if (!isFalVideoModel(model)) {
      return yield* new MediaInputError({
        reason: `${model} is not a fal.ai video model. Use seedance, kling, veo3, or a fal model id such as fal-ai/veo3.`,
      });
    }
    const root = yield* projectRoot(input.projectId);
    const apiKey = yield* requireKey("fal", "video");
    const image = input.image === undefined ? undefined : yield* readSourceImage(input.image);
    const plan = planFalVideo({
      model,
      hasImage: image !== undefined,
      durationSeconds: input.durationSeconds,
    });
    yield* assertWithinCap(input.projectId, plan.estimatedUsd);
    const job = yield* falSubmit({
      apiKey,
      plan,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      image,
    });
    const id = yield* newId();
    const submittedAt = yield* Clock.currentTimeMillis;
    const pending: MediaRecord = {
      id,
      kind: "video",
      status: "pending",
      prompt: input.prompt,
      model,
      backend: "fal",
      ...(plan.estimatedUsd === undefined
        ? {}
        : {
            cost: { usd: Math.round(plan.estimatedUsd * 1_000_000) / 1_000_000, estimated: true },
          }),
      createdAt: isoOf(submittedAt),
      threadId: input.threadId,
      ...(input.image === undefined ? {} : { sourceImages: [input.image] }),
      files: [],
      job: { statusUrl: job.statusUrl, responseUrl: job.responseUrl },
    };
    yield* writeRecord(root, pending, []);
    let delay = VIDEO_POLL_FIRST_DELAY_MS;
    for (;;) {
      if (yield* falCompleted({ apiKey, job })) {
        const finished = yield* finishVideo({ root, apiKey, record: pending });
        return resultOf(root, finished);
      }
      const elapsed = (yield* Clock.currentTimeMillis) - submittedAt;
      if (elapsed + delay > VIDEO_POLL_CAP_MS) return resultOf(root, pending);
      yield* Effect.sleep(Duration.millis(delay));
      delay = Math.min(delay * 1.5, VIDEO_POLL_MAX_DELAY_MS);
    }
  }, provideHttp);

  const findRecord = Effect.fn("MediaService.findRecord")(function* (root: string, id: string) {
    if (!MEDIA_ID.test(id)) return yield* new MediaNotFoundError({ id });
    for (const day of yield* days(root)) {
      const record = (yield* readRecords(root, day)).find((entry) => entry.id === id);
      if (record !== undefined) return record;
    }
    return yield* new MediaNotFoundError({ id });
  });

  const get = Effect.fn("MediaService.get")(function* (
    input: Parameters<MediaService["Service"]["get"]>[0],
  ) {
    const root = yield* projectRoot(input.projectId);
    const record = yield* findRecord(root, input.id);
    if (record.status === "pending" && record.job !== undefined) {
      const apiKey = yield* requireKey("fal", "video");
      if (yield* falCompleted({ apiKey, job: record.job })) {
        return resultOf(root, yield* finishVideo({ root, apiKey, record }));
      }
    }
    return resultOf(root, record);
  }, provideHttp);

  const list = Effect.fn("MediaService.list")(function* (
    input: Parameters<MediaService["Service"]["list"]>[0],
  ) {
    const root = yield* projectRoot(input.projectId);
    const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const found: MediaRecord[] = [];
    for (const day of yield* days(root)) {
      const records = (yield* readRecords(root, day)).filter(
        (record) => input.kind === undefined || record.kind === input.kind,
      );
      found.push(...records);
      if (found.length >= limit) break;
    }
    return found
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((record) => resultOf(root, record));
  });

  return MediaService.of({
    generateImage,
    editImage,
    generateVideo,
    list,
    get,
    spendToday,
  });
});

export const layer = Layer.effect(MediaService, make);
