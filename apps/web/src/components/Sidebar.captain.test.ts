import {
  captainSidebarIndex,
  EMPTY_CAPTAIN_BOARD,
  reduceCaptainBoard,
} from "@t3tools/client-runtime/state/captainBoard";
import { captainHiddenKeysFor } from "@t3tools/client-runtime/state/captainPresentation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterSidebarV2VisibleThreads } from "./Sidebar.logic";

const env = "environment:a" as EnvironmentId;

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

describe("the sidebar's captain filter", () => {
  it("leaves reviewer threads out of the list and nests listed crew", () => {
    const threads = [
      "thread:captain",
      "thread:crew",
      "captain-review:order:1:1",
      "thread:plain",
    ].map((id) => ({
      environmentId: env,
      projectId: "project:1",
      id: id as ThreadId,
      archivedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null } as never,
    }));
    const visible = filterSidebarV2VisibleThreads(
      threads,
      null,
      new Set(),
      captainHiddenKeysFor(new Map([[env, index]]), threads),
    );
    expect(visible.map((entry) => entry.id)).toEqual(["thread:captain", "thread:plain"]);
  });
});
