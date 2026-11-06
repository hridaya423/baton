const STAGGER_MS = 30;
const MAX_STAGGERED_ROWS = 12;
const WINDOW_MS = 600;

/**
 * Hands each thread row mounted during the session's first list load a staggered rise delay.
 * Rows mount in list order, so the mount sequence is the stagger. After the first window closes,
 * nothing rises again: not on re-render, scroll, recycle or a later visit to the list.
 */
export function createFirstLoadReveal() {
  let openedAt: number | null = null;
  let claimed = 0;
  return (nowMs: number): number | null => {
    openedAt ??= nowMs;
    if (nowMs - openedAt > WINDOW_MS || claimed >= MAX_STAGGERED_ROWS) return null;
    return STAGGER_MS * claimed++;
  };
}

export const claimFirstLoadRevealDelay = createFirstLoadReveal();
