import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AnchorIcon, InboxIcon, PauseIcon, PlayIcon } from "lucide-react";

import { useCaptainActions } from "../hooks/useCaptainActions";
import { useCaptainBoards, useCaptainSidebarIndexes } from "../state/captains";
import {
  captainMenuItems,
  captainMenuState,
  countOpenCaptainEscalations,
  type CaptainMenuActionId,
} from "./captain/captainThreads.logic";
import { openNeedsYou } from "./captain/needsYouStore";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

const ACTION_ICONS: Readonly<Record<CaptainMenuActionId, typeof AnchorIcon>> = {
  "make-captain": AnchorIcon,
  "release-captain": AnchorIcon,
  "open-crew-board": AnchorIcon,
  "pause-captain": PauseIcon,
  "resume-captain": PlayIcon,
};

const ACTION_TERMS: Readonly<Record<CaptainMenuActionId, ReadonlyArray<string>>> = {
  "make-captain": ["captain", "crew", "orchestrate", "delegate"],
  "release-captain": ["captain", "crew", "stop", "unmake"],
  "open-crew-board": ["captain", "crew", "board", "orders"],
  "pause-captain": ["captain", "crew", "hold"],
  "resume-captain": ["captain", "crew", "continue"],
};

export function useCommandPaletteCaptainItems(
  activeThread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "lineage" | "archivedAt"
  > | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const indexes = useCaptainSidebarIndexes();
  const boards = useCaptainBoards();
  const runCaptainAction = useCaptainActions();

  const items: Array<CommandPaletteActionItem> = [];
  if (activeThread !== null) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const state = captainMenuState(activeThread, indexes.get(activeThread.environmentId));
    for (const entry of captainMenuItems(state)) {
      const Icon = ACTION_ICONS[entry.id];
      items.push({
        kind: "action",
        value: `action:${entry.id}`,
        searchTerms: ACTION_TERMS[entry.id],
        title: entry.label,
        icon: <Icon className={ITEM_ICON_CLASS} />,
        run: () => runCaptainAction(entry.id, threadRef),
      });
    }
  }

  const { captains, open } = countOpenCaptainEscalations(boards);
  if (captains > 0) {
    items.push({
      kind: "action",
      value: "action:captain-needs-you",
      searchTerms: ["captain", "needs you", "inbox", "escalation", "approve", "question"],
      title: open > 0 ? `Needs you (${open})` : "Needs you",
      description: open > 0 ? "Questions and approvals from your captains" : "Nothing waiting",
      icon: <InboxIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openNeedsYou();
      },
    });
  }
  return items;
}
