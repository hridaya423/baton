import { AnchorIcon } from "lucide-react";
import type { EnvironmentId, OrchestrationV2ThreadCaptainRole, ThreadId } from "@t3tools/contracts";

import { useCaptainNeedsYou, useCaptainOfThread } from "../../state/captains";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The anchor that marks a captain's row, in place of nothing on an ordinary thread's. The thread's
 * own role shows it before the board loads; the board adds whether the captain is paused.
 */
export function CaptainRowGlyph(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  captainRole?: OrchestrationV2ThreadCaptainRole | null | undefined;
}) {
  const captain = useCaptainOfThread(props.environmentId, props.threadId);
  if (captain === null && props.captainRole !== "captain") return null;
  const paused = captain?.status === "paused";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={paused ? "Captain, paused" : "Captain"}
            data-testid="captain-row-glyph"
            className="inline-flex shrink-0 items-center text-dim-foreground"
          />
        }
      >
        <AnchorIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{paused ? "Captain (paused)" : "Captain"}</TooltipPopup>
    </Tooltip>
  );
}

/** How many items wait on the user, on the captain's row. */
export function CaptainRowNeedsYou(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const count = useCaptainNeedsYou(props.environmentId, props.threadId);
  if (count === 0) return null;
  return (
    <Badge size="sm" variant="warning" data-testid="captain-row-needs-you">
      <span className="sr-only">Needs you: </span>
      {count}
    </Badge>
  );
}
