import { openCaptainEscalations } from "@t3tools/client-runtime/state/captainBoard";
import { InboxIcon } from "lucide-react";

import { useCaptainBoards } from "../../state/captains";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { EscalationCard } from "./EscalationCard";
import { useNeedsYouStore } from "./needsYouStore";

function NeedsYouList() {
  const boards = useCaptainBoards();
  const items = [...boards].flatMap(([environmentId, board]) =>
    openCaptainEscalations(board).map((escalation) => ({
      environmentId,
      escalation,
      captainName: board.captains.get(escalation.captainId)?.name,
    })),
  );
  if (items.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Nothing needs you</EmptyTitle>
          <EmptyDescription>
            When a captain needs a decision or an approval, it shows up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul aria-label="Needs you" className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={`${item.environmentId}:${item.escalation.id}`}>
          <EscalationCard
            environmentId={item.environmentId}
            escalation={item.escalation}
            captainName={item.captainName}
          />
        </li>
      ))}
    </ul>
  );
}

export function NeedsYouDialog() {
  const open = useNeedsYouStore((state) => state.open);
  const setOpen = useNeedsYouStore((state) => state.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Needs you</DialogTitle>
          <DialogDescription>
            Decisions and approvals your captains are waiting on.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <NeedsYouList /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
