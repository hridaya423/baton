import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MediaService from "../../../media/MediaService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, readCaller, resolveProjectId } from "../../threadAccess.ts";
import { MediaImageToolkit, MediaStandardToolkit } from "./tools.ts";

const toFailure = (error: MediaService.MediaError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "MediaKeyMissingError" || error._tag === "MediaSpendCapError"
        ? "capability_denied"
        : error._tag === "MediaInputError" || error._tag === "MediaNotFoundError"
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });

const callerScope = Effect.gen(function* () {
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Media tools run from a thread.",
    });
  }
  if (caller.interactionMode === "plan") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Media tools write files and spend money, so they are off in plan mode.",
    });
  }
  return { projectId: caller.projectId, threadId: caller.id };
});

const withMedia = <A>(
  use: (media: MediaService.MediaService["Service"]) => Effect.Effect<A, MediaService.MediaError>,
) => MediaService.MediaService.pipe(Effect.flatMap(use), Effect.mapError(toFailure));

const asItem = ({
  preview: _preview,
  prompt,
  createdAt,
  kind,
  status,
  backend,
  ...rest
}: MediaService.MediaResult) => ({
  ...rest,
  prompt,
  createdAt,
  kind,
  status,
  backend,
});

const imageResult = ({ id, paths, model, cost, seed, preview }: MediaService.MediaResult) => ({
  id,
  paths,
  model,
  ...(cost === undefined ? {} : { cost }),
  ...(seed === undefined ? {} : { seed }),
  ...(preview === undefined ? {} : { preview }),
});

export const layerImages = McpToolAccess.toLayer(MediaImageToolkit, {
  media_image_generate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const result = yield* withMedia((media) => media.generateImage({ ...scope, ...input }));
      return imageResult(result);
    }),
  ),
  media_image_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const result = yield* withMedia((media) => media.editImage({ ...scope, ...input }));
      return imageResult(result);
    }),
  ),
});

export const layerStandard = McpToolAccess.toLayer(MediaStandardToolkit, {
  media_video_generate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const { id, status, paths, model, cost, seed } = yield* withMedia((media) =>
        media.generateVideo({ ...scope, ...input }),
      );
      return {
        id,
        status,
        paths,
        model,
        ...(cost === undefined ? {} : { cost }),
        ...(seed === undefined ? {} : { seed }),
      };
    }),
  ),
  media_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const found = yield* withMedia((media) => media.list({ ...input, projectId }));
      return { media: found.map(asItem) };
    }),
  ),
  media_get: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* callerScope;
      return asItem(yield* withMedia((media) => media.get({ projectId, id: input.id })));
    }),
  ),
});
