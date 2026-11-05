import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

export type MediaBackend = "openai" | "gemini" | "fal";

const BACKEND_LABEL: Readonly<Record<MediaBackend, string>> = {
  openai: "OpenAI",
  gemini: "Gemini",
  fal: "fal.ai",
};

export interface MediaCost {
  readonly usd: number;
  readonly estimated: boolean;
}

export class MediaRequestError extends Schema.TaggedError<MediaRequestError>()(
  "MediaRequestError",
  {
    backend: Schema.Literals(["openai", "gemini", "fal"]),
    status: Schema.optional(Schema.Number),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const label = BACKEND_LABEL[this.backend];
    return this.status === undefined
      ? `${label} request failed: ${this.detail}`
      : `${label} returned ${this.status}: ${this.detail}`;
  }
}

const MAX_DETAIL_CHARACTERS = 300;

const failure = (
  backend: MediaBackend,
  detail: string,
  extra: { readonly status?: number; readonly cause?: unknown } = {},
) =>
  new MediaRequestError({
    backend,
    detail: detail.slice(0, MAX_DETAIL_CHARACTERS),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  detail: Schema.optional(Schema.Unknown),
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

const errorDetail = (text: string) => {
  const body = decodeErrorBody(text);
  if (body._tag === "None") return text;
  const { error, detail } = body.value;
  if (error?.message !== undefined) return error.message;
  return typeof detail === "string" ? detail : text;
};

const execute = Effect.fn("MediaBackends.execute")(function* (
  backend: MediaBackend,
  request: HttpClientRequest.HttpClientRequest,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .execute(request)
    .pipe(
      Effect.mapError((cause) =>
        failure(backend, "the connection failed or timed out.", { cause }),
      ),
    );
  if (response.status >= 200 && response.status < 300) return response;
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  return yield* failure(backend, errorDetail(text), { status: response.status });
});

const decodeBody = <S extends Schema.Top>(backend: MediaBackend, schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(decode),
      Effect.mapError((cause) =>
        failure(backend, "the response was not in the expected shape.", { cause }),
      ),
    ) as Effect.Effect<S["Type"], MediaRequestError, S["DecodingServices"]>;
};

const download = Effect.fn("MediaBackends.download")(function* (
  backend: MediaBackend,
  url: string,
) {
  const response = yield* execute(backend, HttpClientRequest.get(url));
  const buffer = yield* response.arrayBuffer.pipe(
    Effect.mapError((cause) => failure(backend, "the download failed.", { cause })),
  );
  return new Uint8Array(buffer);
});

export interface MediaImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ImageGeneration {
  readonly images: ReadonlyArray<MediaImage>;
  readonly cost: MediaCost | undefined;
}

export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const usd = (value: number, estimated: boolean): MediaCost => ({
  usd: Math.round(value * 1_000_000) / 1_000_000,
  estimated,
});

export const IMAGE_BACKEND_DEFAULTS = {
  openai: "gpt-image-1",
  gemini: "gemini-2.5-flash-image",
} as const;

export const imageBackendForModel = (model: string): "openai" | "gemini" | undefined =>
  /^(gpt-image|chatgpt-image|dall-e)/.test(model)
    ? "openai"
    : /^(gemini|imagen)/.test(model)
      ? "gemini"
      : undefined;

const OPENAI_TOKEN_RATES: Readonly<
  Record<string, { readonly textIn: number; readonly imageIn: number; readonly imageOut: number }>
> = {
  "gpt-image-1": { textIn: 5, imageIn: 10, imageOut: 40 },
  "gpt-image-1-mini": { textIn: 2, imageIn: 2.5, imageOut: 8 },
};
const GEMINI_IMAGE_OUTPUT_RATES: Readonly<Record<string, number>> = {
  "gemini-2.5-flash-image": 30,
  "gemini-3-pro-image-preview": 120,
};

const OPENAI_IMAGE_USD: Readonly<Record<string, number>> = {
  "gpt-image-1": 0.17,
  "gpt-image-1-mini": 0.05,
};
const GEMINI_IMAGE_USD: Readonly<Record<string, number>> = {
  "gemini-2.5-flash-image": 0.04,
  "gemini-3-pro-image-preview": 0.14,
};
const FALLBACK_OPENAI_IMAGE_USD = 0.17;
const FALLBACK_GEMINI_IMAGE_USD = 0.14;

export const estimateImageUsd = (backend: "openai" | "gemini", model: string, count: number) =>
  count *
  (backend === "openai"
    ? (OPENAI_IMAGE_USD[model] ?? FALLBACK_OPENAI_IMAGE_USD)
    : (GEMINI_IMAGE_USD[model] ?? FALLBACK_GEMINI_IMAGE_USD));

const OpenAiImagesResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.String })),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
      input_tokens_details: Schema.optional(
        Schema.Struct({
          text_tokens: Schema.optional(Schema.Number),
          image_tokens: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
});

const OpenAiModelsResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, created: Schema.optional(Schema.Number) })),
});

export const newestOpenAiImageModel = Effect.fn("MediaBackends.newestOpenAiImageModel")(
  function* (apiKey: string) {
    const models = yield* execute(
      "openai",
      HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    ).pipe(Effect.flatMap(decodeBody("openai", OpenAiModelsResponse)));
    const newest = models.data
      .filter((model) => model.id.startsWith("gpt-image") && !/\d{4}-\d{2}-\d{2}$/.test(model.id))
      .toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    return newest?.id ?? IMAGE_BACKEND_DEFAULTS.openai;
  },
  Effect.orElseSucceed(() => IMAGE_BACKEND_DEFAULTS.openai),
);

export interface ImageInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name: string;
}

const blobOf = (input: { readonly bytes: Uint8Array; readonly mimeType: string }) =>
  new Blob([new Uint8Array(input.bytes)], { type: input.mimeType });

export const openAiImages = Effect.fn("MediaBackends.openAiImages")(function* (input: {
  readonly apiKey: string;
  readonly model: string;
  readonly prompt: string;
  readonly count: number;
  readonly size: string | undefined;
  readonly images: ReadonlyArray<ImageInput>;
  readonly mask?: ImageInput | undefined;
}) {
  const base = { model: input.model, prompt: input.prompt, n: input.count };
  const withSize = input.size === undefined ? base : { ...base, size: input.size };
  const request =
    input.images.length === 0
      ? HttpClientRequest.post("https://api.openai.com/v1/images/generations").pipe(
          HttpClientRequest.bodyJsonUnsafe(withSize),
        )
      : HttpClientRequest.post("https://api.openai.com/v1/images/edits").pipe(
          HttpClientRequest.bodyFormData(
            (() => {
              const form = new FormData();
              for (const [key, value] of Object.entries(withSize)) form.append(key, String(value));
              for (const image of input.images) {
                form.append("image[]", blobOf(image), image.name);
              }
              if (input.mask !== undefined) {
                form.append("mask", blobOf(input.mask), input.mask.name);
              }
              return form;
            })(),
          ),
        );
  const body = yield* execute(
    "openai",
    request.pipe(HttpClientRequest.bearerToken(input.apiKey)),
  ).pipe(Effect.flatMap(decodeBody("openai", OpenAiImagesResponse)));
  const rates = OPENAI_TOKEN_RATES[input.model];
  const tokens = body.usage;
  const reported =
    rates !== undefined && tokens?.output_tokens !== undefined
      ? usd(
          ((tokens.input_tokens_details?.text_tokens ?? tokens.input_tokens ?? 0) * rates.textIn +
            (tokens.input_tokens_details?.image_tokens ?? 0) * rates.imageIn +
            tokens.output_tokens * rates.imageOut) /
            1_000_000,
          false,
        )
      : undefined;
  return {
    images: body.data.map((entry): MediaImage => ({
      bytes: new Uint8Array(Buffer.from(entry.b64_json, "base64")),
      mimeType: "image/png",
    })),
    cost: reported ?? usd(estimateImageUsd("openai", input.model, body.data.length), true),
  } satisfies ImageGeneration;
});

const GeminiResponse = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  text: Schema.optional(Schema.String),
                  inlineData: Schema.optional(
                    Schema.Struct({ mimeType: Schema.String, data: Schema.String }),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
  usageMetadata: Schema.optional(
    Schema.Struct({ candidatesTokenCount: Schema.optional(Schema.Number) }),
  ),
});

const ASPECT_RATIO = /^\d{1,2}:\d{1,2}$/;

/** Gemini returns one image per call; `count` calls run one after another. */
export const geminiImages = Effect.fn("MediaBackends.geminiImages")(function* (input: {
  readonly apiKey: string;
  readonly model: string;
  readonly prompt: string;
  readonly count: number;
  readonly size: string | undefined;
  readonly images: ReadonlyArray<ImageInput>;
}) {
  const body = {
    contents: [
      {
        parts: [
          { text: input.prompt },
          ...input.images.map((image) => ({
            inline_data: {
              mime_type: image.mimeType,
              data: Buffer.from(image.bytes).toString("base64"),
            },
          })),
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      ...(input.size !== undefined && ASPECT_RATIO.test(input.size)
        ? { imageConfig: { aspectRatio: input.size } }
        : {}),
    },
  };
  const results = yield* Effect.forEach(Array.from({ length: input.count }), () =>
    execute(
      "gemini",
      HttpClientRequest.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      ).pipe(
        HttpClientRequest.setHeader("x-goog-api-key", input.apiKey),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    ).pipe(Effect.flatMap(decodeBody("gemini", GeminiResponse))),
  );
  const images: MediaImage[] = [];
  let outputTokens: number | undefined;
  for (const result of results) {
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((part) => part.inlineData !== undefined)?.inlineData;
    if (inline === undefined) {
      const refusal = parts.find((part) => part.text !== undefined)?.text;
      return yield* failure("gemini", refusal ?? "the response held no image.");
    }
    images.push({
      bytes: new Uint8Array(Buffer.from(inline.data, "base64")),
      mimeType: inline.mimeType,
    });
    const used = result.usageMetadata?.candidatesTokenCount;
    if (used !== undefined) outputTokens = (outputTokens ?? 0) + used;
  }
  const rate = GEMINI_IMAGE_OUTPUT_RATES[input.model];
  return {
    images,
    cost:
      rate !== undefined && outputTokens !== undefined
        ? usd((outputTokens * rate) / 1_000_000, false)
        : usd(estimateImageUsd("gemini", input.model, images.length), true),
  } satisfies ImageGeneration;
});

interface FalVideoModel {
  readonly text: string;
  readonly image: string;
  readonly usdPerSecond: number;
  readonly defaultSeconds: number;
  readonly duration: (seconds: number) => string;
}

const FAL_VIDEO_MODELS: Readonly<Record<string, FalVideoModel>> = {
  seedance: {
    text: "fal-ai/bytedance/seedance/v1/pro/text-to-video",
    image: "fal-ai/bytedance/seedance/v1/pro/image-to-video",
    usdPerSecond: 0.12,
    defaultSeconds: 5,
    duration: String,
  },
  kling: {
    text: "fal-ai/kling-video/v2.1/master/text-to-video",
    image: "fal-ai/kling-video/v2.1/master/image-to-video",
    usdPerSecond: 0.28,
    defaultSeconds: 5,
    duration: String,
  },
  veo3: {
    text: "fal-ai/veo3",
    image: "fal-ai/veo3/image-to-video",
    usdPerSecond: 0.4,
    defaultSeconds: 8,
    duration: (seconds) => `${seconds}s`,
  },
};

export const FAL_DEFAULT_VIDEO_MODEL = "seedance";

export interface FalVideoPlan {
  readonly endpoint: string;
  readonly model: string;
  readonly seconds: number | undefined;
  readonly durationParameter: string | undefined;
  readonly estimatedUsd: number | undefined;
}

export const planFalVideo = (input: {
  readonly model: string;
  readonly hasImage: boolean;
  readonly durationSeconds: number | undefined;
}): FalVideoPlan => {
  const known = FAL_VIDEO_MODELS[input.model];
  if (known === undefined) {
    return {
      endpoint: input.model,
      model: input.model,
      seconds: input.durationSeconds,
      durationParameter:
        input.durationSeconds === undefined ? undefined : String(input.durationSeconds),
      estimatedUsd: undefined,
    };
  }
  const seconds = input.durationSeconds ?? known.defaultSeconds;
  return {
    endpoint: input.hasImage ? known.image : known.text,
    model: input.model,
    seconds,
    durationParameter: known.duration(seconds),
    estimatedUsd: known.usdPerSecond * seconds,
  };
};

export const isFalVideoModel = (model: string) => model in FAL_VIDEO_MODELS || model.includes("/");

const FalSubmitResponse = Schema.Struct({
  request_id: Schema.String,
  status_url: Schema.String,
  response_url: Schema.String,
});
const FalStatusResponse = Schema.Struct({ status: Schema.String });
const FalResultResponse = Schema.Struct({
  video: Schema.Struct({ url: Schema.String }),
  seed: Schema.optional(Schema.Number),
});

const falRequest = (apiKey: string, request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(HttpClientRequest.setHeader("authorization", `Key ${apiKey}`));

export interface FalJob {
  readonly requestId: string;
  readonly statusUrl: string;
  readonly responseUrl: string;
}

export const falSubmit = Effect.fn("MediaBackends.falSubmit")(function* (input: {
  readonly apiKey: string;
  readonly plan: FalVideoPlan;
  readonly prompt: string;
  readonly aspectRatio: string | undefined;
  readonly image: ImageInput | undefined;
}) {
  const body = {
    prompt: input.prompt,
    ...(input.image === undefined
      ? {}
      : {
          image_url: `data:${input.image.mimeType};base64,${Buffer.from(input.image.bytes).toString("base64")}`,
        }),
    ...(input.plan.durationParameter === undefined
      ? {}
      : { duration: input.plan.durationParameter }),
    ...(input.aspectRatio === undefined ? {} : { aspect_ratio: input.aspectRatio }),
  };
  const submitted = yield* execute(
    "fal",
    falRequest(
      input.apiKey,
      HttpClientRequest.post(`https://queue.fal.run/${input.plan.endpoint}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    ),
  ).pipe(Effect.flatMap(decodeBody("fal", FalSubmitResponse)));
  return {
    requestId: submitted.request_id,
    statusUrl: submitted.status_url,
    responseUrl: submitted.response_url,
  } satisfies FalJob;
});

export const falCompleted = Effect.fn("MediaBackends.falCompleted")(function* (input: {
  readonly apiKey: string;
  readonly job: Pick<FalJob, "statusUrl">;
}) {
  const status = yield* execute(
    "fal",
    falRequest(input.apiKey, HttpClientRequest.get(input.job.statusUrl)),
  ).pipe(Effect.flatMap(decodeBody("fal", FalStatusResponse)));
  return status.status === "COMPLETED";
});

export const falVideo = Effect.fn("MediaBackends.falVideo")(function* (input: {
  readonly apiKey: string;
  readonly job: Pick<FalJob, "responseUrl">;
}) {
  const result = yield* execute(
    "fal",
    falRequest(input.apiKey, HttpClientRequest.get(input.job.responseUrl)),
  ).pipe(Effect.flatMap(decodeBody("fal", FalResultResponse)));
  return {
    bytes: yield* download("fal", result.video.url),
    seed: result.seed,
  };
});
