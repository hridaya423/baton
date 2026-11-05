import {
  captainSidebarIndex,
  EMPTY_CAPTAIN_BOARD,
  reduceCaptainBoard,
} from "@t3tools/client-runtime/state/captainBoard";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import {
  captainHiddenKeysFor,
  captainHiddenThreadKeys,
  captainMenuItems,
  captainMenuState,
  captainThreadKey,
} from "./captainThreads.logic";

const env = "environment:a" as EnvironmentId;
const thread = (id: string, fields: Record<string, unknown> = {}) =>
  ({
    id: id as ThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null },
    archivedAt: null,
    delegatedFrom: null,
    ...fields,
  }) as never;

const board = reduceCaptainBoard(EMPTY_CAPTAIN_BOARD, {
  type: "snapshot",
  captains: [
    { id: "captain:a", threadId: "thread:captain", status: "active" },
    { id: "captain:p", threadId: "thread:paused", status: "paused" },
  ] as never,
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
});
const index = captainSidebarIndex(board);

describe("captainMenuState", () => {
  it("offers Make captain on a normal thread", () => {
    expect(captainMenuState(thread("thread:plain"), index)).toEqual({ kind: "make" });
    expect(captainMenuItems({ kind: "make" }).map((item) => item.id)).toEqual(["make-captain"]);
  });

  it("does not offer it on a reviewer, crew, subagent, linked or archived thread", () => {
    const cases = [
      thread("captain-review:order:1:1"),
      thread("thread:crew"),
      thread("thread:sub", {
        lineage: { parentThreadId: "thread:captain", relationshipToParent: "subagent" },
      }),
      thread("thread:linked", { delegatedFrom: { environmentId: "environment:b" } }),
      thread("thread:old", { archivedAt: "2026-11-05T10:00:00.000Z" }),
    ];
    for (const candidate of cases) {
      expect(captainMenuState(candidate, index)).toEqual({ kind: "none" });
    }
  });

  it("offers nothing where the server has no captains", () => {
    expect(captainMenuState(thread("thread:plain"), undefined)).toEqual({ kind: "none" });
  });

  it("gives a captain Pause or Resume, with Release always beside it", () => {
    const active = captainMenuState(thread("thread:captain"), index);
    expect(active).toEqual({ kind: "captain", status: "active" });
    expect(captainMenuItems(active).map((item) => item.id)).toEqual([
      "open-crew-board",
      "pause-captain",
      "release-captain",
    ]);
    const paused = captainMenuState(thread("thread:paused"), index);
    expect(captainMenuItems(paused).map((item) => item.id)).toEqual([
      "open-crew-board",
      "resume-captain",
      "release-captain",
    ]);
  });
});

describe("captainHiddenThreadKeys", () => {
  const indexes = new Map([[env, index]]);
  const key = (id: string) => captainThreadKey(env, id as ThreadId);

  it("hides reviewer threads and nests crew under a listed captain", () => {
    const hidden = captainHiddenThreadKeys(indexes, new Set([key("thread:captain")]));
    expect([...hidden].sort()).toEqual(
      [key("captain-review:order:1:1"), key("thread:crew")].sort(),
    );
  });

  it("leaves reviewer threads out of the sidebar list and nests listed crew", () => {
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
      captainHiddenKeysFor(indexes, threads),
    );
    expect(visible.map((entry) => entry.id)).toEqual(["thread:captain", "thread:plain"]);
  });

  it("keeps crew in the list when their captain's row is not there", () => {
    const hidden = captainHiddenThreadKeys(indexes, new Set());
    expect([...hidden]).toEqual([key("captain-review:order:1:1")]);
  });
});
