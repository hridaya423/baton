import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { CaptainMenuActionId } from "@t3tools/client-runtime/state/captainPresentation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { captainEnvironment, useCaptainSidebarIndexes } from "../../state/captains";
import { useAtomCommand } from "../../state/use-atom-command";

/** Runs the captain items of the thread menu, the same for the title menu and the command palette. */
export function useCaptainThreadActions() {
  const navigation = useNavigation();
  const indexes = useCaptainSidebarIndexes();
  const makeCaptain = useAtomCommand(captainEnvironment.makeCaptain, { reportFailure: false });
  const releaseCaptain = useAtomCommand(captainEnvironment.releaseCaptain, {
    reportFailure: false,
  });
  const updateCaptain = useAtomCommand(captainEnvironment.updateCaptain, { reportFailure: false });

  const fail = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "Try again.");
  };

  return async (
    action: CaptainMenuActionId,
    thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  ) => {
    const { environmentId } = thread;
    const captain = indexes.get(environmentId)?.captainByThreadId.get(thread.id);
    const openBoard = () =>
      navigation.navigate("CaptainBoard", { environmentId, threadId: thread.id });
    switch (action) {
      case "make-captain": {
        const result = await makeCaptain({ environmentId, input: { threadId: thread.id } });
        if (result._tag === "Success") openBoard();
        else fail("Could not make captain", result);
        return;
      }
      case "release-captain": {
        if (captain === undefined) return;
        Dialog.confirm({
          title: "Release captain?",
          message: `${captain.name} stops directing its crew. Crew threads stay. Make captain brings it back.`,
          confirmText: "Release",
          destructive: true,
          onConfirm: () =>
            void releaseCaptain({ environmentId, input: { captainId: captain.id } }).then(
              (result) => fail("Could not release captain", result),
            ),
        });
        return;
      }
      case "pause-captain":
      case "resume-captain": {
        if (captain === undefined) return;
        const paused = action === "pause-captain";
        const result = await updateCaptain({
          environmentId,
          input: { captainId: captain.id, status: paused ? "paused" : "active" },
        });
        fail(paused ? "Could not pause captain" : "Could not resume captain", result);
        return;
      }
      case "open-crew-board":
        openBoard();
        return;
    }
  };
}
