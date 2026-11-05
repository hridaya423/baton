import { describe, expect, it } from "vite-plus/test";

import { buildCaptainMenuActions, captainMenuKey } from "./captain-menu";

const all = { make: true, release: true, update: true };
const ids = (...args: Parameters<typeof buildCaptainMenuActions>) =>
  buildCaptainMenuActions(...args).map((action) => action.id);

describe("buildCaptainMenuActions", () => {
  it("offers Make captain on a normal thread and Pause with Release on a captain", () => {
    expect(ids({ kind: "make" }, all)).toEqual(["make-captain"]);
    expect(ids({ kind: "captain", status: "active" }, all)).toEqual([
      "open-crew-board",
      "pause-captain",
      "release-captain",
    ]);
  });

  it("swaps Pause for Resume, so the way back is always in the menu", () => {
    expect(ids({ kind: "captain", status: "paused" }, all)).toEqual([
      "open-crew-board",
      "resume-captain",
      "release-captain",
    ]);
  });

  it("leaves out what the user's grants do not allow, and marks Release destructive", () => {
    expect(ids({ kind: "make" }, { ...all, make: false })).toEqual([]);
    expect(
      ids({ kind: "captain", status: "active" }, { make: false, release: false, update: false }),
    ).toEqual(["open-crew-board"]);
    const release = buildCaptainMenuActions({ kind: "captain", status: "active" }, all).at(-1);
    expect(release?.attributes).toEqual({ destructive: true });
  });

  it("keys the menu by what changes it", () => {
    expect(captainMenuKey({ kind: "none" })).toBe("none");
    expect(captainMenuKey({ kind: "captain", status: "paused" })).toBe("captain:paused");
  });
});
