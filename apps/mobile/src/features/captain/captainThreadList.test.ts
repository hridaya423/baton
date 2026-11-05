import {
  captainSidebarIndex,
  EMPTY_CAPTAIN_BOARD,
  reduceCaptainBoard,
} from "@t3tools/client-runtime/state/captainBoard";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { omitCaptainNestedThreads } from "./captainThreadList";

const env = "environment:a" as EnvironmentId;
const thread = (id: string, archivedAt: string | null = null) => ({
  environmentId: env,
  id: id as ThreadId,
  archivedAt,
});

const index = captainSidebarIndex(
  reduceCaptainBoard(EMPTY_CAPTAIN_BOARD, {
    type: "snapshot",
    captains: [{ id: "captain:a", threadId: "thread:captain", status: "active" }] as never,
    orders: [
      {
        id: "order:1",
        captainId: "captain:a",
        threadId: "thread:crew",
        state: "reviewing",
        review: { threadIds: ["captain-review:order:1:1"] },
      },
    ] as never,
    escalations: [],
  }),
);
const indexes = new Map([[env, index]]);

describe("omitCaptainNestedThreads", () => {
  it("leaves reviewer threads out and nests crew under a listed captain", () => {
    const threads = [
      "thread:captain",
      "thread:crew",
      "captain-review:order:1:1",
      "thread:plain",
    ].map((id) => thread(id));
    expect(omitCaptainNestedThreads(threads, indexes).map((entry) => entry.id)).toEqual([
      "thread:captain",
      "thread:plain",
    ]);
  });

  it("keeps crew listed when their captain's row is not", () => {
    const threads = [thread("thread:captain", "2026-11-05T10:00:00Z"), thread("thread:crew")];
    expect(omitCaptainNestedThreads(threads, indexes).map((entry) => entry.id)).toEqual([
      "thread:captain",
      "thread:crew",
    ]);
  });

  it("returns the same list where there is nothing to leave out", () => {
    const threads = [thread("thread:plain")];
    expect(omitCaptainNestedThreads(threads, indexes)).toBe(threads);
    expect(omitCaptainNestedThreads(threads, new Map())).toBe(threads);
  });
});
