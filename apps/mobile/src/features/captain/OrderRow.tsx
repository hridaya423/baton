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
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { BatonWorkingIndicator } from "../../components/baton/BatonWorkingIndicator";
import { HudLabel } from "../../components/baton/HudLabel";
import { Prism, PrismSweep } from "../../components/baton/Prism";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { StatusBadge, type StatusBadgeTone } from "../../components/ui/StatusBadge";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { captainEnvironment } from "../../state/captains";
import { useThreadShell } from "../../state/entities";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { playHaptic } from "../../lib/haptics";
import { cn } from "../../lib/cn";
import { EscalationCard } from "./EscalationCard";
import { isSolidMaterial, justLanded, orderMaterial, type OrderMaterial } from "./orderMaterial";

const BADGE_TONE = {
  success: "success",
  error: "danger",
  info: "progress",
  warning: "attention",
  neutral: "neutral",
} as const satisfies Record<CaptainTone | "neutral" | "warning", StatusBadgeTone>;

function Pill(props: { readonly label: string; readonly tone: keyof typeof BADGE_TONE }) {
  return <StatusBadge label={props.label} tone={BADGE_TONE[props.tone]} />;
}

const MATERIAL_FRAME: Record<OrderMaterial, string> = {
  planned: "border border-dashed border-foreground-tertiary",
  building: "border border-border",
  checking: "border border-border",
  built: "border border-border",
  landed: "border border-border",
  scrapped: "border border-dashed border-foreground-tertiary opacity-40",
};

const MATERIAL_FILL_MS = 300;

/** Fills or empties the card once when its material changes, and settles it in place when it lands. */
function useOrderMaterialMotion(state: CaptainBoardOrder["state"]) {
  const reducedMotion = useReducedMotion();
  const material = orderMaterial(state);
  const solid = isSolidMaterial(material);
  const fill = useSharedValue(solid ? 1 : 0);
  const scale = useSharedValue(1);
  const previousState = useRef<CaptainBoardOrder["state"] | null>(null);
  const [landKey, setLandKey] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- plays the one-shot fill and land motion when the server moves the order
  useEffect(() => {
    const previous = previousState.current;
    previousState.current = state;
    if (previous === null) return;
    fill.set(
      reducedMotion ? (solid ? 1 : 0) : withTiming(solid ? 1 : 0, { duration: MATERIAL_FILL_MS }),
    );
    if (!justLanded(previous, state)) return;
    playHaptic("land");
    setLandKey((key) => key + 1);
    if (!reducedMotion) {
      scale.set(
        withSequence(
          withTiming(1.02, { duration: 90 }),
          withSpring(1, { damping: 14, stiffness: 260, mass: 0.6 }),
        ),
      );
    }
  }, [state, solid, reducedMotion, fill, scale]);

  const fillStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
  const settleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return { material, fillStyle, settleStyle, landKey };
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
    if (result._tag === "Success") return true;
    if (isAtomCommandInterrupted(result)) return false;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : fallback);
    return false;
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
        ).then((dropped) => {
          if (dropped) playHaptic("drop");
        }),
    });

  const summary = order.lastReport?.summary ?? "";
  const motion = useOrderMaterialMotion(state);
  const hasActions = canLand(state, order.kind) || canRetry(state) || canDrop(state);
  return (
    <Animated.View
      accessible={false}
      className={cn(
        "overflow-hidden rounded-2xl border-continuous",
        MATERIAL_FRAME[motion.material],
      )}
      style={motion.settleStyle}
      testID="captain-order-row"
    >
      <Animated.View
        pointerEvents="none"
        className="absolute inset-0 bg-grouped-card"
        style={motion.fillStyle}
      />
      {motion.material === "landed" ? (
        <Prism width="100%" height={1.5} style={{ position: "absolute", top: 0, left: 0 }} />
      ) : null}
      {motion.material === "checking" ? (
        <View
          pointerEvents="none"
          className="absolute inset-x-4 top-0 h-px bg-adaptive-sky-600-400 opacity-60"
        />
      ) : null}
      <PrismSweep
        playKey={motion.landKey}
        height={2}
        durationMs={700}
        style={{ position: "absolute", top: 0, left: 0, right: 0 }}
      />
      <View className="gap-2 p-4">
        <View className="flex-row items-start gap-2">
          <Text textRole="body" className="min-w-0 flex-1 font-t3-medium" numberOfLines={2}>
            {order.title}
          </Text>
          <StatusBadge
            label={ORDER_STATE_LABELS[state]}
            tone={failed ? "danger" : motion.material === "building" ? "progress" : "neutral"}
            leading={
              motion.material === "building" ? (
                <BatonWorkingIndicator size={11} blockClassName="bg-adaptive-sky-600-400" />
              ) : undefined
            }
          />
        </View>
        <HudLabel>
          {[
            ORDER_KIND_LABELS[order.kind],
            model === null ? null : formatModelSlugName(model),
            order.kind === "change" ? DELIVERY_LABELS[order.delivery] : null,
            order.retries > 0
              ? order.retries === 1
                ? "1 retry"
                : `${order.retries} retries`
              : null,
            machine === null ? null : `On ${machine}`,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </HudLabel>
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
          <View className="rounded-xl border-continuous bg-danger px-3 py-2">
            <Text textRole="footnote" className="text-danger-foreground" accessibilityRole="alert">
              {land?.error ?? "Landing failed."}
            </Text>
          </View>
        ) : null}
        <View className="flex-row flex-wrap items-center gap-x-4">
          {land?.prUrl === undefined ? null : (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open the pull request"
              className="py-1 active:opacity-60"
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
              className="py-1 active:opacity-60"
              onPress={() => setDetailsOpen((current) => !current)}
            >
              <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                {detailsOpen ? "Hide details" : "Details"}
              </Text>
            </Pressable>
          ) : null}
          {order.threadId === null ? null : (
            <Pressable
              accessibilityRole="button"
              className="ml-auto py-1 active:opacity-60"
              onPress={() =>
                openDetail({
                  name: "Thread",
                  params: { environmentId: crewEnvironmentId, threadId: order.threadId! },
                })
              }
            >
              <Text textRole="footnote" className="font-t3-medium text-foreground">
                Open thread
              </Text>
            </Pressable>
          )}
        </View>
        {detailsOpen ? (
          <OrderDetails environmentId={environmentId} captain={captain} order={order} />
        ) : null}
        {props.escalations.map((escalation) => (
          <EscalationCard
            key={escalation.id}
            environmentId={environmentId}
            escalation={escalation}
          />
        ))}
        {hasActions ? (
          <View className="flex-row flex-wrap items-center gap-2 pt-1">
            {canLand(state, order.kind) ? (
              <Menu
                actions={LAND_ACTIONS(order.delivery)}
                accessibilityLabel={`Land ${order.title}`}
                onPressAction={({ nativeEvent }) =>
                  onLand(nativeEvent.event as CaptainOrderDelivery)
                }
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
        ) : null}
        {error === null ? null : (
          <Text textRole="footnote" className="text-danger-foreground" accessibilityRole="alert">
            {error}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}
