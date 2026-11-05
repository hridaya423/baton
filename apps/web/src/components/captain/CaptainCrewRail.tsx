import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CaptainCrewDot } from "@t3tools/client-runtime/state/captainBoard";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useCaptainCrew } from "../../state/captains";
import { useThreadShell } from "../../state/entities";
import { SidebarMenuButton } from "../ui/sidebar";
import { StatusDot, type StatusDotTone } from "../ui/status-dot";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useOpenCrewThread } from "./useOpenCrewThread";

const DOT: Record<CaptainCrewDot, { readonly tone: StatusDotTone; readonly label: string }> = {
  running: { tone: "info", label: "Running" },
  "needs-you": { tone: "warning", label: "Needs you" },
  done: { tone: "success", label: "Done" },
};

function CrewRailRow(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  dot: CaptainCrewDot;
  fallbackTitle: string;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(threadRef);
  const openThread = useOpenCrewThread();
  const routeTarget = useThreadRouteTarget();
  const isActive =
    routeTarget?.kind === "server" &&
    routeTarget.threadRef.environmentId === props.environmentId &&
    routeTarget.threadRef.threadId === props.threadId;
  const title = shell?.title ?? props.fallbackTitle;
  const dot = DOT[props.dot];
  return (
    <li className="list-none">
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        aria-current={isActive ? "page" : undefined}
        aria-label={`${title}, ${dot.label}`}
        data-testid="captain-crew-row"
        data-crew-dot={props.dot}
        onClick={() => void openThread(threadRef)}
      >
        <StatusDot tone={dot.tone} />
        <span className="flex min-w-0 flex-1">
          <MiddleTruncate value={title} showTitle={false} />
        </span>
      </SidebarMenuButton>
    </li>
  );
}

/** A captain's crew, nested under its row. Rows are plain buttons, so they stay out of the list's arrow-key order. */
export function CaptainCrewRail(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const crew = useCaptainCrew(props.environmentId, props.threadId);
  if (crew.length === 0) return null;
  return (
    <ul
      aria-label="Crew"
      data-testid="captain-crew-rail"
      className="ms-4 flex flex-col gap-px border-s border-sidebar-foreground/15 ps-1.5"
    >
      {crew.map((entry) => (
        <CrewRailRow
          key={entry.threadId}
          environmentId={props.environmentId}
          threadId={entry.threadId}
          dot={entry.dot}
          fallbackTitle={entry.order.title}
        />
      ))}
    </ul>
  );
}
