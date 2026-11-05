import { OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as MediaService from "../../../media/MediaService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MediaService.MediaService,
];

const ImagePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000));
const Model = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const Cost = Schema.Struct({ usd: Schema.Number, estimated: Schema.Boolean });

const Preview = Schema.Struct({ mimeType: Schema.String, data: Schema.String });

const ImageResult = Schema.Struct({
  id: Schema.String,
  paths: Schema.Array(Schema.String),
  model: Schema.String,
  cost: Schema.optional(Cost),
  seed: Schema.optional(Schema.Number),
  preview: Schema.optional(Preview),
});

const MediaItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["image", "video"]),
  status: Schema.Literals(["complete", "pending"]),
  paths: Schema.Array(Schema.String),
  model: Schema.String,
  backend: Schema.Literals(["openai", "gemini", "fal"]),
  cost: Schema.optional(Cost),
  seed: Schema.optional(Schema.Number),
  prompt: Schema.String,
  createdAt: Schema.String,
});

export const MediaImageGenerateTool = Tool.make("media_image_generate", {
  description:
    "Make an image with the user's OpenAI or Gemini key. Saves it under .baton/media/ in the project and returns its path, cost and a preview. Costs money, capped per project per day. referenceImages are existing files to build on.",
  parameters: Schema.Struct({
    prompt: Prompt,
    model: Schema.optional(
      Model.annotate({
        description:
          "Default: the newest OpenAI gpt-image model, else gemini-2.5-flash-image. Other ids go to their backend as written.",
      }),
    ),
    size: Schema.optional(
      Schema.String.annotate({
        description:
          "OpenAI: 1024x1024, 1536x1024, 1024x1536 or auto. Gemini: an aspect ratio such as 16:9.",
      }),
    ),
    count: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
    referenceImages: Schema.optional(
      Schema.Array(
        ImagePath.annotate({ description: "Absolute path to a png, jpeg or webp file." }),
      ).check(Schema.isMaxLength(8)),
    ),
  }),
  success: ImageResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Generate image")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MediaImageEditTool = Tool.make("media_image_edit", {
  description:
    "Edit an existing image from a prompt. Saves a new file and keeps the original. Costs money, capped per project per day. A mask is an OpenAI-only png whose transparent area marks what to change.",
  parameters: Schema.Struct({
    image: ImagePath.annotate({ description: "Absolute path to a png, jpeg or webp file." }),
    prompt: Prompt,
    mask: Schema.optional(ImagePath),
    model: Schema.optional(Model),
  }),
  success: ImageResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Edit image")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MediaVideoGenerateTool = Tool.make("media_video_generate", {
  description:
    "Make a video clip with fal.ai. Waits up to 10 minutes; if it is still running, returns status pending and call media_get with the id later. Costs money, capped per project per day. Pass image to animate a still.",
  parameters: Schema.Struct({
    prompt: Prompt,
    image: Schema.optional(ImagePath),
    model: Schema.optional(
      Model.annotate({
        description: "seedance (default), kling, veo3, or a fal model id.",
      }),
    ),
    durationSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })).annotate({
        description: "Seedance and Kling: 5 or 10. Veo 3: 8.",
      }),
    ),
    aspectRatio: Schema.optional(Schema.String.annotate({ description: "16:9, 9:16 or 1:1." })),
  }),
  success: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["complete", "pending"]),
    paths: Schema.Array(Schema.String),
    model: Schema.String,
    cost: Schema.optional(Cost),
    seed: Schema.optional(Schema.Number),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Generate video")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MediaListTool = Tool.make("media_list", {
  description: "List media made in a project, newest first. Defaults to this thread's project.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    kind: Schema.optional(Schema.Literals(["image", "video"])),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({ media: Schema.Array(MediaItem) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List media")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MediaGetTool = Tool.make("media_get", {
  description:
    "Get one media record by id. For a pending video, checks the job and saves the file if it is done.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: MediaItem,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get media")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const MediaImageToolkit = Toolkit.make(MediaImageGenerateTool, MediaImageEditTool);

export const MediaStandardToolkit = Toolkit.make(
  MediaVideoGenerateTool,
  MediaListTool,
  MediaGetTool,
);

export const MediaToolkit = Toolkit.make(
  MediaImageGenerateTool,
  MediaImageEditTool,
  MediaVideoGenerateTool,
  MediaListTool,
  MediaGetTool,
);
