import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

export const MediaSpendInput = Schema.Struct({ projectId: ProjectId });
export type MediaSpendInput = typeof MediaSpendInput.Type;

/** What a project's media tools have spent today (UTC), against its daily cap. */
export const MediaSpend = Schema.Struct({
  day: Schema.String,
  usd: Schema.Number,
  capUsd: Schema.Number,
});
export type MediaSpend = typeof MediaSpend.Type;

export class MediaSpendError extends Schema.TaggedError<MediaSpendError>()("MediaSpendError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
