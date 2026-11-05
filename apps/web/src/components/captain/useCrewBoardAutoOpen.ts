import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useCaptainOfThread } from "../../state/captains";

export function useCrewBoardAutoOpen(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly enabled: boolean;
}) {
  const { threadRef, enabled } = input;
  const captain = useCaptainOfThread(
    threadRef?.environmentId ?? ("" as ScopedThreadRef["environmentId"]),
    threadRef?.threadId ?? ("" as ScopedThreadRef["threadId"]),
  );
  const isCaptain = captain !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the board surface in the right panel store when a captain thread is first shown
  useEffect(() => {
    if (!enabled || !isCaptain || threadRef === null) return;
    useRightPanelStore.getState().offerCrewBoard(threadRef);
  }, [enabled, isCaptain, threadRef]);
}
