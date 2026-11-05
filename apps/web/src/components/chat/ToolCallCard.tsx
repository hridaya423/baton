import { ChevronDownIcon } from "lucide-react";
import { use, type ReactNode } from "react";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import type { WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { WorkLogList } from "./WorkLog";
import { TimelineRowCtx, type TimelineRow, type TimelineWorkEntry } from "./timelineRowContext";
import { ToolActivityIconView } from "./TimelineToolActivityIcon";
import { workEntryIconName } from "./TimelineWorkEntryRow.logic";
import { SimpleWorkEntryRow } from "./TimelineWorkEntryRow";
import { liveToolCardTail, toolGroupStats } from "./ToolCallCard.logic";
import { TimelineRowTimestamp } from "./TimelineRowParts";

const LIVE_TAIL_ROWS = 4;
const STACK_LIMIT = 4;

const cardFrame = "border-border bg-foreground/[0.025]";
const toolCardClassName = {
  whole: cn(cardFrame, "mt-1.5 rounded-xl border"),
  top: cn(cardFrame, "mt-1.5 rounded-t-xl border border-b-0"),
  bottom: cn(cardFrame, "mb-2 rounded-b-xl border border-t-0"),
};

function entryIconKey(entry: TimelineWorkEntry) {
  const icon = entry.toolIcon ?? entry.toolSource?.icon;
  if (!icon) return workEntryIconName(entry);
  return icon._tag === "website"
    ? `website:${icon.pageUrl}`
    : icon._tag === "themed-logo"
      ? `logo:${icon.logoUrl}`
      : `app:${JSON.stringify(icon.app)}`;
}

/** Overlapping icons for the distinct tools in a group, first use first. */
function ToolStack({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const seen = new Map<string, TimelineWorkEntry>();
  for (const entry of entries) {
    if (entry.itemType === "reasoning") continue;
    const key = entryIconKey(entry);
    if (!seen.has(key)) seen.set(key, entry);
    if (seen.size === STACK_LIMIT) break;
  }
  return (
    <span className="flex shrink-0 items-center [&>*+*]:-ms-1" aria-hidden>
      {[...seen].map(([key, entry]) => (
        <span
          key={key}
          className="flex size-5 items-center justify-center rounded-full bg-muted text-icon-muted ring-2 ring-background"
        >
          <ToolActivityIconView
            icon={entry.toolIcon ?? entry.toolSource?.icon}
            fallbackName={workEntryIconName(entry)}
            className="block size-3.5 shrink-0 stroke-2"
            muted={false}
          />
        </span>
      ))}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDownIcon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-icon-muted transition-transform duration-200",
        open && "rotate-180",
      )}
    />
  );
}

function CardHeader(props: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  label: ReactNode;
  accessibleLabel: string;
  failedCount: number;
  trailing?: ReactNode;
  expanded: boolean;
  className: string;
  /** Absent for a card with nothing more to open; it keeps the chevron's space. */
  onToggle?: () => void;
}) {
  const Root = props.onToggle ? "button" : "div";
  return (
    <Root
      {...(props.onToggle
        ? { type: "button" as const, "aria-expanded": props.expanded, onClick: props.onToggle }
        : {})}
      aria-label={props.accessibleLabel}
      className={cn(
        "group/timeline-row flex h-8 w-full min-w-0 items-center gap-2.5 px-3.5 text-left text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        props.onToggle && "cursor-pointer",
        props.className,
      )}
    >
      <ToolStack entries={props.entries} />
      <span className="min-w-0 truncate text-muted-foreground">{props.label}</span>
      {props.failedCount > 0 ? (
        <span className="shrink-0 text-destructive-foreground">{props.failedCount} failed</span>
      ) : null}
      <span className="ms-auto flex shrink-0 items-center gap-2 text-caption text-muted-foreground tabular-nums">
        {props.trailing}
        {/* Lines the header time up with the row durations, left of the status column. */}
        <span className="size-3.5" aria-hidden />
        {props.onToggle ? (
          <Chevron open={props.expanded} />
        ) : (
          <span className="size-3.5" aria-hidden />
        )}
      </span>
    </Root>
  );
}

/** The newest calls and thoughts. Rows only append, so the card grows to 4 rows and stops. */
function ToolCardTail({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const { workspaceRoot } = use(TimelineRowCtx);
  return (
    <div className="border-t border-border px-1 py-1">
      <WorkLogList density="card">
        {entries.map((entry) => (
          <SimpleWorkEntryRow key={entry.id} workEntry={entry} workspaceRoot={workspaceRoot} />
        ))}
      </WorkLogList>
    </div>
  );
}

function toolNoun(count: number) {
  return count === 1 ? "tool" : "tools";
}

/** The working run's calls in one card, so progress is visible without a click. */
export function LiveToolCard({
  entries,
  expanded,
  onToggle,
}: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stats = toolGroupStats(entries);
  const tail = liveToolCardTail(entries, LIVE_TAIL_ROWS);
  const hiddenCount = expanded
    ? 0
    : stats.toolCount - tail.filter((entry) => entry.itemType !== "reasoning").length;
  const label = `Using ${stats.toolCount} ${toolNoun(stats.toolCount)}`;
  return (
    <div className={expanded ? toolCardClassName.top : toolCardClassName.whole}>
      <CardHeader
        entries={entries}
        label={label}
        accessibleLabel={[
          label,
          stats.failedCount > 0 ? `${stats.failedCount} failed` : null,
          hiddenCount > 0
            ? `${hiddenCount} earlier ${hiddenCount === 1 ? "call" : "calls"} hidden`
            : null,
        ]
          .filter(Boolean)
          .join(", ")}
        failedCount={stats.failedCount}
        trailing={hiddenCount > 0 ? `+${hiddenCount} earlier` : null}
        expanded={expanded}
        className="rounded-t-xl"
        onToggle={onToggle}
      />
      {expanded ? null : <ToolCardTail entries={tail} />}
    </div>
  );
}

/** Finished tools: one quiet line that opens into the card. */
export function ToolGroupLine({ row }: { row: Extract<TimelineRow, { kind: "work-toggle" }> }) {
  const ctx = use(TimelineRowCtx);
  const stats = toolGroupStats(row.groupedEntries);
  const duration = stats.durationMs !== null ? formatDuration(stats.durationMs) : null;
  return (
    <div
      className={
        row.expanded
          ? toolCardClassName.top
          : "mt-1.5 rounded-md border border-transparent hover:bg-foreground/[0.03]"
      }
    >
      <CardHeader
        entries={row.groupedEntries}
        label={
          <>
            <span className="@max-md/chat-lane:hidden">{row.summary}</span>
            <span className="@md/chat-lane:hidden">
              Used {stats.toolCount} {toolNoun(stats.toolCount)}
            </span>
          </>
        }
        accessibleLabel={[
          row.summary,
          stats.failedCount > 0 ? `${stats.failedCount} failed` : null,
          duration,
        ]
          .filter(Boolean)
          .join(", ")}
        failedCount={stats.failedCount}
        trailing={
          <>
            <TimelineRowTimestamp createdAt={row.createdAt} timestampFormat={ctx.timestampFormat} />
            {duration}
          </>
        }
        expanded={row.expanded}
        className={row.expanded ? "rounded-t-xl" : "rounded-md"}
        onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
      />
    </div>
  );
}

/** Bottom of an open card: the full list of calls. */
export function ToolCardBody({ children }: { children: ReactNode }) {
  return (
    <div className={toolCardClassName.bottom}>
      <div className="border-t border-border px-1 py-1">{children}</div>
    </div>
  );
}

export function groupHasTools(entries: ReadonlyArray<WorkLogEntry>) {
  return toolGroupStats(entries).toolCount > 0;
}
