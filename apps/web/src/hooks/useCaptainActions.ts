import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { CaptainMenuActionId } from "@t3tools/client-runtime/state/captainPresentation";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import { captainEnvironment, readCaptainSidebarIndex } from "../state/captains";
import { useAtomCommand } from "../state/use-atom-command";

/** Runs the captain items of the thread menu, the same for the sidebar, the header and the palette. */
export function useCaptainActions() {
  const makeCaptain = useAtomCommand(captainEnvironment.makeCaptain, { reportFailure: false });
  const releaseCaptain = useAtomCommand(captainEnvironment.releaseCaptain, {
    reportFailure: false,
  });
  const updateCaptain = useAtomCommand(captainEnvironment.updateCaptain, { reportFailure: false });

  return async (action: CaptainMenuActionId, threadRef: ScopedThreadRef) => {
    const { environmentId, threadId } = threadRef;
    const openCrewBoard = (ref: ScopedThreadRef) =>
      useRightPanelStore.getState().open(ref, "crew-board");
    const captain = readCaptainSidebarIndex(environmentId)?.captainByThreadId.get(threadId);
    const fail = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) => {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    };
    switch (action) {
      case "make-captain": {
        const result = await makeCaptain({ environmentId, input: { threadId } });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) fail("Could not make captain", result);
          return;
        }
        openCrewBoard(threadRef);
        return;
      }
      case "release-captain": {
        if (captain === undefined) return;
        const result = await releaseCaptain({ environmentId, input: { captainId: captain.id } });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) fail("Could not release captain", result);
          return;
        }
        toastManager.add({
          type: "success",
          title: "Captain released",
          description: "Crew threads stay. Make captain brings it back.",
        });
        return;
      }
      case "pause-captain":
      case "resume-captain": {
        if (captain === undefined) return;
        const status = action === "pause-captain" ? "paused" : "active";
        const result = await updateCaptain({
          environmentId,
          input: { captainId: captain.id, status },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          fail(
            status === "paused" ? "Could not pause captain" : "Could not resume captain",
            result,
          );
        }
        return;
      }
      case "open-crew-board":
        openCrewBoard(threadRef);
        return;
    }
  };
}
