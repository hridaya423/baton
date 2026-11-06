import { useAtomValue } from "@effect/atom-react";
import {
  CAPTAIN_BOARD_COLUMNS,
  captainBoardColumns,
  openEscalationsByOrder,
} from "@t3tools/client-runtime/state/captainBoard";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AnchorIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

import { captainEnvironment, useCaptainBoard } from "../../state/captains";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Text } from "../ui/text";
import { BOARD_COLUMN_LABELS } from "@t3tools/client-runtime/state/captainPresentation";
import { EscalationCard } from "./EscalationCard";
import { OrderCard } from "./OrderCard";

export function CrewBoardPanel(props: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const board = useCaptainBoard(environmentId);
  const updateCaptain = useAtomCommand(captainEnvironment.updateCaptain, { reportFailure: false });
  const canUpdate = useAtomValue(captainEnvironment.updateCaptain.permissionAtom(environmentId));
  const [showDropped, setShowDropped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captain =
    [...board.captains.values()].find(
      (candidate) => candidate.threadId === threadId && candidate.status !== "released",
    ) ?? null;

  if (captain === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AnchorIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            {board.loaded ? "This thread is not a captain" : "Loading the board"}
          </EmptyTitle>
          {board.loaded ? (
            <EmptyDescription>
              Make captain from the thread menu to hand work to a crew.
            </EmptyDescription>
          ) : null}
        </EmptyHeader>
      </Empty>
    );
  }

  const { columns, dropped, looseEscalations } = captainBoardColumns(board, captain.id);
  const escalationsByOrder = openEscalationsByOrder(board.escalations.values());
  const working = columns.running.length + columns.checking.length;
  const paused = captain.status === "paused";
  const noOrders =
    dropped.length === 0 &&
    looseEscalations.length === 0 &&
    CAPTAIN_BOARD_COLUMNS.every((column) => columns[column].length === 0);

  const toggleStatus = async () => {
    setError(null);
    const result = await updateCaptain({
      environmentId,
      input: { captainId: captain.id, status: paused ? "active" : "paused" },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not update the captain.");
  };

  return (
    <section
      aria-label={`${captain.name} crew board`}
      data-testid="crew-board"
      className="@container/board flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <AnchorIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Text variant="label" truncate render={<h2 className="min-w-0 flex-1" />}>
          {captain.name}
        </Text>
        <Text variant="meta" tone="muted" numeric>
          {working} of {captain.charter.crewCap} crew working
        </Text>
        {paused ? <Badge variant="warning">Paused</Badge> : null}
        <Button
          size="compact"
          variant="secondary"
          disabled={!canUpdate}
          onClick={() => void toggleStatus()}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        {dropped.length === 0 ? null : (
          <Button
            size="compact"
            variant="ghost-muted"
            aria-pressed={showDropped}
            onClick={() => setShowDropped((current) => !current)}
          >
            {showDropped ? "Hide dropped" : `Show dropped (${dropped.length})`}
          </Button>
        )}
      </header>
      {error === null ? null : (
        <Text variant="meta" tone="destructive" render={<p role="alert" />}>
          {error}
        </Text>
      )}
      {noOrders ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No orders yet</EmptyTitle>
            <EmptyDescription>
              Tell the captain what you want done. It splits the goal into orders, and each order
              runs in its own crew thread.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto @5xl/board:grid @5xl/board:auto-cols-[minmax(15rem,1fr)] @5xl/board:grid-flow-col @5xl/board:gap-3 @5xl/board:overflow-x-auto @5xl/board:overflow-y-hidden">
          {CAPTAIN_BOARD_COLUMNS.map((column) => {
            const orders = columns[column];
            const loose = column === "needs-you" ? looseEscalations : [];
            return (
              <section
                key={column}
                aria-label={BOARD_COLUMN_LABELS[column]}
                data-testid={`crew-board-column-${column}`}
                data-empty={orders.length + loose.length === 0}
                className={cn(
                  "flex shrink-0 flex-col gap-2 data-[empty=true]:hidden @5xl/board:min-h-0 @5xl/board:shrink @5xl/board:data-[empty=true]:flex",
                  column === "needs-you" && "order-first @5xl/board:order-none",
                )}
              >
                <div className="flex items-center gap-2 px-1">
                  <Text variant="meta" tone="muted" emphasis>
                    {BOARD_COLUMN_LABELS[column]}
                  </Text>
                  <Text variant="meta" tone="dim" numeric>
                    {orders.length + loose.length}
                  </Text>
                </div>
                <div className="flex flex-col gap-2 @5xl/board:min-h-0 @5xl/board:flex-1 @5xl/board:overflow-y-auto">
                  {loose.map((escalation) => (
                    <EscalationCard
                      key={escalation.id}
                      environmentId={environmentId}
                      escalation={escalation}
                    />
                  ))}
                  {orders.map((order) => (
                    <OrderCard
                      key={order.id}
                      environmentId={environmentId}
                      captain={captain}
                      order={order}
                      escalations={escalationsByOrder.get(order.id) ?? []}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {showDropped ? (
        <section aria-label="Dropped orders" className="flex max-h-[40%] flex-col gap-2">
          <Text variant="meta" tone="muted" emphasis>
            Dropped
          </Text>
          <div className="flex flex-col gap-2 overflow-y-auto @5xl/board:grid @5xl/board:auto-cols-[minmax(15rem,1fr)] @5xl/board:grid-flow-col @5xl/board:gap-3 @5xl/board:overflow-x-auto">
            {dropped.map((order) => (
              <OrderCard
                key={order.id}
                environmentId={environmentId}
                captain={captain}
                order={order}
                escalations={[]}
              />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
