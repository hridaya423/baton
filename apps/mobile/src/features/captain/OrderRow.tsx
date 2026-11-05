import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import {
  canDrop,
  canLand,
  canRetry,
  DELIVERY_LABELS,
  LAND_DELIVERIES,
  ORDER_KIND_LABELS,
  ORDER_STATE_LABELS,
  reviewSummary,
  type CaptainTone,
  verifySummary,
} from "@t3tools/client-runtime/state/captainPresentation";
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
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { captainEnvironment } from "../../state/captains";
import { useThreadShell } from "../../state/entities";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { EscalationCard } from "./EscalationCard";

const TONE_PILL: Record<CaptainTone | "neutral" | "warning", string> = {
  success: "bg-adaptive-emerald-500-a12-a16 text-adaptive-emerald-700-300",
  error: "bg-adaptive-rose-500-a12-a16 text-danger-foreground",
  info: "bg-adaptive-sky-500-a12-a16 text-adaptive-sky-600-400",
  warning: "bg-adaptive-amber-500-a12-a16 text-warning-foreground",
  neutral: "bg-subtle-strong text-foreground-muted",
};

function Pill(props: { readonly label: string; readonly tone: keyof typeof TONE_PILL }) {
  const [fill, text] = TONE_PILL[props.tone].split(" ") as [string, string];
  return (
    <View className={cn("rounded-[5px] px-[5px] py-px", fill)}>
      <Text textRole="label" className={cn("font-t3-medium", text)}>
        {props.label}
      </Text>
    </View>
  );
}

const SEVERITY_TONE = { high: "error", medium: "warning", low: "neutral" } as const;

function OrderDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly captain: Captain;
  readonly order: CaptainBoardOrder;
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
      <Text textRole="footnote" className="text-foreground-muted">
        {query.error === null ? "Loading details…" : "Could not load the details."}
      </Text>
    );
  }
  return (
    <View className="gap-3">
      {detail.verify === null ? null : (
        <View className="gap-1">
          <Text textRole="label" className="text-foreground-muted" numberOfLines={1}>
            {detail.verify.cmd}
          </Text>
          <View className="rounded-lg bg-card p-2">
            <Text textRole="caption" selectable className="font-mono">
              {detail.verify.logTail.length === 0 ? "No output." : detail.verify.logTail}
            </Text>
          </View>
        </View>
      )}
      {detail.review === null
        ? null
        : detail.review.findings.map((finding) => (
            <View
              key={`${finding.severity}:${finding.file}:${finding.line ?? 0}:${finding.scenario}`}
              className="gap-1"
            >
              <View className="flex-row items-center gap-2">
                <Pill label={finding.severity} tone={SEVERITY_TONE[finding.severity]} />
                <Text
                  textRole="label"
                  className="min-w-0 shrink text-foreground-muted"
                  numberOfLines={1}
                >
                  {finding.file}
                  {finding.line === undefined ? "" : `:${finding.line}`}
                </Text>
              </View>
              <Text textRole="footnote">{finding.scenario}</Text>
            </View>
          ))}
    </View>
  );
}

const LAND_ACTIONS = (current: CaptainOrderDelivery): MenuAction[] =>
  LAND_DELIVERIES.map((delivery) => ({
    id: delivery,
    title: `${DELIVERY_LABELS[delivery]}${delivery === current ? " (this order's default)" : ""}`,
  }));

/** One order on a captain's board, with what happened to it and what the user can do next. */
export function OrderRow(props: {
  readonly environmentId: EnvironmentId;
  readonly captain: Captain;
  readonly order: CaptainBoardOrder;
  readonly escalations: ReadonlyArray<CaptainEscalation>;
}) {
  const { environmentId, captain, order } = props;
  const state = order.state;
  const crewEnvironmentId = order.environmentId ?? environmentId;
  const linkedNames = useLinkedEnvironments(order.environmentId === null ? null : environmentId);
  const machine =
    order.environmentId === null
      ? null
      : (linkedNames.get(order.environmentId) ?? "another machine");
  const crewShell = useThreadShell(
    order.threadId === null
      ? null
      : { environmentId: crewEnvironmentId, threadId: order.threadId as ThreadId },
  );
  const openDetail = useOpenWorkspaceDetail();
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
  const review = order.review === null ? null : reviewSummary(order.review);
  const hasDetails = order.verify !== null || (order.review?.findingsCount ?? 0) > 0;
  const failed = state === "land_failed" || state === "verify_failed";

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

  const startLanding = async (delivery: CaptainOrderDelivery) =>
    run(
      () => landOrder({ environmentId, input: { orderId: order.id, delivery } }),
      "Could not land the order.",
    );

  const onLand = (delivery: CaptainOrderDelivery) => {
    if (delivery !== "merge") {
      void startLanding(delivery);
      return;
    }
    Dialog.confirm({
      title: "Merge this order?",
      message: `Merge "${order.title}" into the base branch? Merging cannot be undone from here.`,
      confirmText: "Merge",
      destructive: true,
      onConfirm: () => void startLanding(delivery),
    });
  };

  const onDrop = () =>
    Dialog.confirm({
      title: "Drop this order?",
      message: `Drop "${order.title}"? The crew thread stops. The order stays under Dropped on the board.`,
      confirmText: "Drop order",
      destructive: true,
      onConfirm: () =>
        void run(
          () => dropOrder({ environmentId, input: { orderId: order.id } }),
          "Could not drop the order.",
        ),
    });

  const summary = order.lastReport?.summary ?? "";
  return (
    <View
      accessible={false}
      className="gap-2 rounded-2xl border-continuous bg-grouped-card p-4"
      testID="captain-order-row"
    >
      <View className="flex-row items-start gap-2">
        <Text textRole="body" className="min-w-0 flex-1 font-t3-medium" numberOfLines={2}>
          {order.title}
        </Text>
        <Pill label={ORDER_STATE_LABELS[state]} tone={failed ? "error" : "neutral"} />
      </View>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <Pill label={ORDER_KIND_LABELS[order.kind]} tone="neutral" />
        {model === null ? null : (
          <Text textRole="label" className="text-foreground-muted">
            {formatModelSlugName(model)}
          </Text>
        )}
        {order.kind === "change" ? (
          <Text textRole="label" className="text-foreground-muted">
            {DELIVERY_LABELS[order.delivery]}
          </Text>
        ) : null}
        {order.retries > 0 ? (
          <Text textRole="label" className="text-foreground-muted">
            {order.retries === 1 ? "1 retry" : `${order.retries} retries`}
          </Text>
        ) : null}
      </View>
      {machine === null ? null : (
        <Text textRole="label" className="text-foreground-muted">
          On {machine}
        </Text>
      )}
      {order.branch === null ? null : (
        <Text textRole="label" className="font-mono text-foreground-muted" numberOfLines={1}>
          {order.branch}
        </Text>
      )}
      {summary.length === 0 ? null : (
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={3}>
          {order.lastReport?.status === "blocked" ? "Blocked: " : ""}
          {summary}
        </Text>
      )}
      {verify === null && review === null ? null : (
        <View className="flex-row flex-wrap items-center gap-2">
          {verify === null ? null : (
            <Pill label={verify.label} tone={verify.passed ? "success" : "error"} />
          )}
          {review === null ? null : <Pill label={review.label} tone={review.tone} />}
          {review?.findings == null ? null : (
            <Text textRole="label" className="text-foreground-muted">
              {review.findings}
            </Text>
          )}
          {order.review?.sameProvider === true ? (
            <Pill label="Same provider" tone="warning" />
          ) : null}
        </View>
      )}
      {state === "land_failed" ? (
        <Text textRole="footnote" className="text-danger-foreground" accessibilityRole="alert">
          {land?.error ?? "Landing failed."}
        </Text>
      ) : null}
      {land?.prUrl === undefined ? null : (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open the pull request"
          className="self-start py-1 active:opacity-60"
          onPress={() => void Linking.openURL(land.prUrl!)}
        >
          <Text textRole="footnote" className="font-t3-medium text-primary-text">
            Pull request
          </Text>
        </Pressable>
      )}
      {hasDetails ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: detailsOpen }}
          className="self-start py-1 active:opacity-60"
          onPress={() => setDetailsOpen((current) => !current)}
        >
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {detailsOpen ? "Hide details" : "Details"}
          </Text>
        </Pressable>
      ) : null}
      {detailsOpen ? (
        <OrderDetails environmentId={environmentId} captain={captain} order={order} />
      ) : null}
      {props.escalations.map((escalation) => (
        <EscalationCard key={escalation.id} environmentId={environmentId} escalation={escalation} />
      ))}
      <View className="flex-row flex-wrap items-center gap-2 pt-1">
        {order.threadId === null ? null : (
          <Button
            label="Open thread"
            tone="text"
            size="compact"
            onPress={() =>
              openDetail({
                name: "Thread",
                params: { environmentId: crewEnvironmentId, threadId: order.threadId! },
              })
            }
          />
        )}
        {canLand(state, order.kind) ? (
          <Menu
            actions={LAND_ACTIONS(order.delivery)}
            accessibilityLabel={`Land ${order.title}`}
            onPressAction={({ nativeEvent }) => onLand(nativeEvent.event as CaptainOrderDelivery)}
          >
            <Button
              label="Land"
              tone="primary"
              size="compact"
              disabled={!canLandPermission || pending}
              onPress={() => undefined}
            />
          </Menu>
        ) : null}
        {canRetry(state) ? (
          <Button
            label="Retry"
            tone="secondary"
            size="compact"
            disabled={!canRetryPermission || pending}
            onPress={() =>
              void run(
                () => retryOrder({ environmentId, input: { orderId: order.id } }),
                "Could not retry the order.",
              )
            }
          />
        ) : null}
        {canDrop(state) ? (
          <Button
            label="Drop"
            tone="danger"
            size="compact"
            disabled={!canDropPermission || pending}
            onPress={onDrop}
          />
        ) : null}
      </View>
      {error === null ? null : (
        <Text textRole="footnote" className="text-danger-foreground" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}
