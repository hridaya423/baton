import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { captainSidebarIndex, EMPTY_CAPTAIN_BOARD, reduceCaptainBoard } from "./captainBoard.ts";
import {
  canDrop,
  canLand,
  canRetry,
  captainHiddenKeysFor,
  captainHiddenThreadKeys,
  captainMenuItems,
  captainMenuState,
  captainThreadKey,
  reviewSummary,
} from "./captainPresentation.ts";

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

  it("keeps crew in the list when their captain's row is not there", () => {
    const hidden = captainHiddenThreadKeys(indexes, new Set());
    expect([...hidden]).toEqual([key("captain-review:order:1:1")]);
  });

  it("gives archived captains no row to nest under", () => {
    const threads = [
      { environmentId: env, id: "thread:captain" as ThreadId, archivedAt: "2026-11-05T10:00:00Z" },
    ];
    expect([...captainHiddenKeysFor(indexes, threads)]).toEqual([key("captain-review:order:1:1")]);
  });

  it("reads roles from the threads before any board has loaded", () => {
    const listedThread = (id: string, fields: Record<string, unknown>) => ({
      environmentId: env,
      id: id as ThreadId,
      archivedAt: null,
      ...fields,
    });
    const threads = [
      listedThread("thread:captain", { captainRole: "captain" }),
      listedThread("thread:crew", { captainRole: "crew", groupedUnderThreadId: "thread:captain" }),
      listedThread("thread:review", {
        captainRole: "reviewer",
        groupedUnderThreadId: "thread:crew",
      }),
      // Released: the captain's role is cleared, so its crew list on their own again.
      listedThread("thread:released", { captainRole: null }),
      listedThread("thread:orphan", {
        captainRole: "crew",
        groupedUnderThreadId: "thread:released",
      }),
    ];
    expect([...captainHiddenKeysFor(new Map(), threads)].sort()).toEqual(
      [key("thread:crew"), key("thread:review")].sort(),
    );
  });
});

describe("order actions and summaries", () => {
  it("lands only accepted or failed-to-land change orders", () => {
    expect(canLand("accepted", "change")).toBe(true);
    expect(canLand("land_failed", "change")).toBe(true);
    expect(canLand("accepted", "report")).toBe(false);
    expect(canLand("landed", "change")).toBe(false);
  });

  it("retries and drops what is in flight, drops what is queued, and neither once finished", () => {
    expect(canRetry("verify_failed")).toBe(true);
    expect(canRetry("queued")).toBe(false);
    expect(canDrop("queued")).toBe(true);
    expect(canDrop("landed")).toBe(false);
  });

  it("reads a review's verdict and finding count", () => {
    const review = (verdict: "approve" | "reject" | null, findingsCount: number) =>
      reviewSummary({ verdict, findingsCount } as never);
    expect(review("approve", 0)).toEqual({
      label: "Review approved",
      tone: "success",
      findings: "0 findings",
    });
    expect(review("reject", 1)).toEqual({
      label: "Review rejected",
      tone: "error",
      findings: "1 finding",
    });
    expect(review(null, 3)).toEqual({ label: "In review", tone: "info", findings: null });
  });
});
