import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatModelSlugName } from "@t3tools/shared/model";
import type {
  Captain,
  CaptainBoardOrder,
  CaptainEscalation,
  CaptainOrderDelivery,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { captainEnvironment } from "../../state/captains";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  boardOrderState,
  canDrop,
  canLand,
  canRetry,
  DELIVERY_LABELS,
  LAND_DELIVERIES,
  ORDER_KIND_LABELS,
  ORDER_STATE_LABELS,
  verifySummary,
} from "./captainLabels";
import { EscalationCard } from "./EscalationCard";
import { useOpenCrewThread } from "./useOpenCrewThread";

const SEVERITY_VARIANTS = { high: "error", medium: "warning", low: "secondary" } as const;

function OrderDetails(props: {
  environmentId: EnvironmentId;
  captain: Captain;
  order: CaptainBoardOrder;
}) {
  const query = useEnvironmentQuery(
    captainEnvironment.orders({
      environmentId: props.environmentId,
      input: { captainId: props.captain.id },
    }),
  );
  const detail = query.data?.orders.find((candidate) => candidate.id === props.order.id);
  if (detail === undefined) {
    return (
      <Text variant="meta" tone="muted" render={<p role="status" />}>
        {query.error === null ? "Loading details…" : "Could not load the details."}
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {detail.verify === null ? null : (
        <div className="flex flex-col gap-1">
          <Text variant="meta" tone="muted" mono truncate>
            {detail.verify.cmd}
          </Text>
          <Text
            variant="caption"
            mono
            render={
              <pre
                aria-label="Check log"
                className="max-h-40 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap"
              />
            }
          >
            {detail.verify.logTail.length === 0 ? "No output." : detail.verify.logTail}
          </Text>
        </div>
      )}
      {detail.review === null || detail.review.findings.length === 0 ? null : (
        <ul aria-label="Review findings" className="flex flex-col gap-1.5">
          {detail.review.findings.map((finding) => (
            <li
              key={`${finding.severity}:${finding.file}:${finding.line ?? 0}:${finding.scenario}`}
              className="flex flex-col gap-0.5"
            >
              <div className="flex items-center gap-1.5">
                <Badge size="sm" variant={SEVERITY_VARIANTS[finding.severity]}>
                  {finding.severity}
                </Badge>
                <Text variant="meta" tone="muted" mono truncate>
                  {finding.file}
                  {finding.line === undefined ? "" : `:${finding.line}`}
                </Text>
              </div>
              <Text variant="meta" render={<p />}>
                {finding.scenario}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LandMenu(props: {
  disabled: boolean;
  delivery: CaptainOrderDelivery;
  onLand: (delivery: CaptainOrderDelivery) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="compact" disabled={props.disabled} />}>
        Land
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        {LAND_DELIVERIES.map((delivery) => (
          <MenuItem key={delivery} onClick={() => props.onLand(delivery)}>
            {DELIVERY_LABELS[delivery]}
            {delivery === props.delivery ? " (this order's default)" : ""}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export function OrderCard(props: {
  environmentId: EnvironmentId;
  captain: Captain;
  order: CaptainBoardOrder;
  escalations: ReadonlyArray<CaptainEscalation>;
}) {
  const { environmentId, captain, order } = props;
  const state = boardOrderState(order);
  const crewEnvironmentId = order.environmentId ?? environmentId;
  const linkedNames = useLinkedEnvironments(order.environmentId === null ? null : environmentId);
  const machine =
    order.environmentId === null
      ? null
      : (linkedNames.get(order.environmentId) ?? "another machine");
  const crewConnected = useConnectedEnvironmentIds().includes(crewEnvironmentId);
  const crewShell = useThreadShell(
    order.threadId === null ? null : scopeThreadRef(crewEnvironmentId, order.threadId),
  );
  const openCrewThread = useOpenCrewThread();
  const landOrder = useAtomCommand(captainEnvironment.landOrder, { reportFailure: false });
  const retryOrder = useAtomCommand(captainEnvironment.retryOrder, { reportFailure: false });
  const dropOrder = useAtomCommand(captainEnvironment.dropOrder, { reportFailure: false });
  const canLandPermission = useAtomValue(
    captainEnvironment.landOrder.permissionAtom(environmentId),
  );
  const canRetryPermission = useAtomValue(
    captainEnvironment.retryOrder.permissionAtom(environmentId),
  );
  const canDropPermission = useAtomValue(
    captainEnvironment.dropOrder.permissionAtom(environmentId),
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const model = crewShell?.modelSelection.model ?? order.placement.model ?? null;
  const land = order.land ?? null;
  const verify = order.verify === null ? null : verifySummary(order.verify.exit);
  const review = order.review;
  const hasDetails = order.verify !== null || (review !== null && review.findingsCount > 0);

  const run = async (
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    fallback: string,
  ) => {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : fallback);
  };

  const onLand = async (delivery: CaptainOrderDelivery) => {
    if (delivery === "merge") {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        `Merge "${order.title}" into the base branch? Merging cannot be undone from here.`,
        { title: "Merge this order?", confirmLabel: "Merge", variant: "destructive" },
      );
      if (confirmed !== true) return;
    }
    await run(
      () => landOrder({ environmentId, input: { orderId: order.id, delivery } }),
      "Could not land the order.",
    );
  };

  const onDrop = async () => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      `Drop "${order.title}"? The crew thread stops. The order stays under Dropped on the board.`,
      { title: "Drop this order?", confirmLabel: "Drop order", variant: "destructive" },
    );
    if (confirmed !== true) return;
    await run(
      () => dropOrder({ environmentId, input: { orderId: order.id } }),
      "Could not drop the order.",
    );
  };

  return (
    <article
      aria-label={order.title}
      data-testid="captain-order-card"
      data-order-state={state}
      className="flex flex-col gap-2 rounded-card border border-border bg-card p-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Text variant="label" truncate render={<h3 className="min-w-0 flex-1" />}>
          {order.title}
        </Text>
        <Badge
          size="sm"
          variant={state === "land_failed" || state === "verify_failed" ? "error" : "secondary"}
        >
          {ORDER_STATE_LABELS[state]}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge size="sm" variant="outline">
          {ORDER_KIND_LABELS[order.kind]}
        </Badge>
        {model === null ? null : (
          <Text variant="meta" tone="muted" truncate>
            {formatModelSlugName(model)}
          </Text>
        )}
        {order.kind === "change" ? (
          <Text variant="meta" tone="muted">
            {DELIVERY_LABELS[order.delivery]}
          </Text>
        ) : null}
        {order.retries > 0 ? (
          <Text variant="meta" tone="muted">
            {order.retries === 1 ? "1 retry" : `${order.retries} retries`}
          </Text>
        ) : null}
      </div>
      {machine === null ? null : (
        <Text variant="meta" tone="muted">
          On {machine}
        </Text>
      )}
      {order.branch === null ? null : (
        <Text variant="meta" tone="muted" mono render={<div className="flex min-w-0" />}>
          <MiddleTruncate value={order.branch} />
        </Text>
      )}
      {order.lastReport === null || order.lastReport.summary.length === 0 ? null : (
        <Text variant="meta" tone="muted" render={<p className="line-clamp-2" />}>
          {order.lastReport.status === "blocked" ? "Blocked: " : ""}
          {order.lastReport.summary}
        </Text>
      )}
      {verify === null && review === null ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {verify === null ? null : (
            <Badge size="sm" variant={verify.passed ? "success" : "error"}>
              {verify.label}
            </Badge>
          )}
          {review === null ? null : (
            <Badge
              size="sm"
              variant={
                review.verdict === "approve"
                  ? "success"
                  : review.verdict === "reject"
                    ? "error"
                    : "info"
              }
            >
              {review.verdict === "approve"
                ? "Review approved"
                : review.verdict === "reject"
                  ? "Review rejected"
                  : "In review"}
            </Badge>
          )}
          {review === null || review.verdict === null ? null : (
            <Text variant="meta" tone="muted">
              {review.findingsCount === 1 ? "1 finding" : `${review.findingsCount} findings`}
            </Text>
          )}
          {review?.sameProvider === true ? (
            <Tooltip>
              <TooltipTrigger render={<Badge size="sm" variant="warning" />}>
                Same provider
              </TooltipTrigger>
              <TooltipPopup>
                The reviewer runs on the crew's provider, so this is a weaker second opinion.
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      )}
      {state === "land_failed" ? (
        <Text variant="meta" tone="destructive" render={<p role="alert" />}>
          {land?.error ?? "Landing failed."}
        </Text>
      ) : null}
      {land?.prUrl === undefined ? null : (
        <InlineButton render={<a href={land.prUrl} target="_blank" rel="noreferrer noopener" />}>
          Pull request
          <ExternalLinkIcon aria-hidden className="size-3" />
        </InlineButton>
      )}
      {hasDetails ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger variant="muted">
            {detailsOpen ? "Hide details" : "Details"}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {detailsOpen ? (
              <div className="pt-2">
                <OrderDetails environmentId={environmentId} captain={captain} order={order} />
              </div>
            ) : null}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {props.escalations.map((escalation) => (
        <EscalationCard key={escalation.id} environmentId={environmentId} escalation={escalation} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {order.threadId === null || !crewConnected ? null : (
          <Button
            size="compact"
            variant="ghost"
            onClick={() => openCrewThread(scopeThreadRef(crewEnvironmentId, order.threadId!))}
          >
            Open thread
          </Button>
        )}
        {canLand(state, order.kind) ? (
          <LandMenu
            disabled={!canLandPermission || pending}
            delivery={order.delivery}
            onLand={(delivery) => void onLand(delivery)}
          />
        ) : null}
        {canRetry(state) ? (
          <Button
            size="compact"
            variant="secondary"
            disabled={!canRetryPermission || pending}
            onClick={() =>
              void run(
                () => retryOrder({ environmentId, input: { orderId: order.id } }),
                "Could not retry the order.",
              )
            }
          >
            Retry
          </Button>
        ) : null}
        {canDrop(state) ? (
          <Button
            size="compact"
            variant="destructive-outline"
            disabled={!canDropPermission || pending}
            onClick={() => void onDrop()}
          >
            Drop
          </Button>
        ) : null}
      </div>
      {error === null ? null : (
        <Text variant="meta" tone="destructive" render={<p role="alert" />}>
          {error}
        </Text>
      )}
    </article>
  );
}
