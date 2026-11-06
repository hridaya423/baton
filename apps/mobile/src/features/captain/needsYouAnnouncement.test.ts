import { describe, expect, it } from "vite-plus/test";

import { resetNeedsYouAnnouncementForTest, shouldAnnounceNeedsYou } from "./needsYouAnnouncement";

describe("shouldAnnounceNeedsYou", () => {
  it("stays quiet on mount and announces each later arrival once", () => {
    resetNeedsYouAnnouncementForTest();
    expect(shouldAnnounceNeedsYou(null, 2)).toBe(false);
    expect(shouldAnnounceNeedsYou(2, 3)).toBe(true);
    // A second mounted entry sees the same rise.
    expect(shouldAnnounceNeedsYou(2, 3)).toBe(false);
    expect(shouldAnnounceNeedsYou(3, 2)).toBe(false);
    expect(shouldAnnounceNeedsYou(2, 3)).toBe(true);
  });

  it("does not announce items that were waiting before a remount", () => {
    resetNeedsYouAnnouncementForTest();
    expect(shouldAnnounceNeedsYou(null, 0)).toBe(false);
    expect(shouldAnnounceNeedsYou(0, 1)).toBe(true);
    expect(shouldAnnounceNeedsYou(null, 1)).toBe(false);
  });
});
