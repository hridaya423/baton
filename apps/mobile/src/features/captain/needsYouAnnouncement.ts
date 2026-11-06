let announced = 0;

/**
 * True when the open count rose past what was already announced, so a list that mounts with items
 * waiting stays quiet and two mounted entries announce one arrival once.
 */
export function shouldAnnounceNeedsYou(previous: number | null, open: number): boolean {
  const rose = previous !== null && open > previous && open > announced;
  announced = previous === null ? Math.max(announced, open) : open;
  return rose;
}

export function resetNeedsYouAnnouncementForTest(): void {
  announced = 0;
}
