import type { CaptainBoardColumns } from "@t3tools/client-runtime/state/captainBoard";
import { useState } from "react";
import { View } from "react-native";

import { HudLabel } from "../../components/baton/HudLabel";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { isBuiltMaterial, orderMaterial, type OrderMaterial } from "./orderMaterial";

const MAX_BLOCKS = 12;
const MIN_BAR = 8;
// The mark in units: caps 4.4 long, bars 10, all 6 thick, 1.2 apart.
const THICKNESS = 22;
const UNIT = THICKNESS / 6;
const CAP = 4.4 * UNIT;
const BAR = 10 * UNIT;
const GAP = 1.2 * UNIT;
const CAP_RADIUS = 1.2 * UNIT;

const BLOCK_CLASS: Record<Exclude<OrderMaterial, "scrapped">, string> = {
  planned: "border border-dashed border-foreground-tertiary",
  building: "border-[1.5px] border-foreground-muted",
  checking: "border-[1.5px] border-foreground-muted",
  built: "bg-foreground",
  landed: "bg-foreground",
  failed: "border-[1.5px] border-danger-foreground",
};

/**
 * A captain's orders built into the mark: a cap at each end and one bar per order, solid once
 * built, outlined while planned or under way, danger-outlined when it failed. Screen readers get
 * the crew sentence instead.
 */
export function CrewStack(props: {
  readonly columns: CaptainBoardColumns["columns"];
  readonly working: number;
  readonly crewCap: number;
  readonly paused: boolean;
}) {
  const orders = [
    ...props.columns.done,
    ...props.columns["needs-you"],
    ...props.columns.checking,
    ...props.columns.running,
    ...props.columns.queued,
  ].map((order) => ({ id: order.id, material: orderMaterial(order.state) }));
  const built = orders.filter(({ material }) => isBuiltMaterial(material)).length;
  const failed = orders.filter(({ material }) => material === "failed").length;
  const shown = orders.slice(0, MAX_BLOCKS);
  const [width, setWidth] = useState(0);
  // Bars narrow to keep the whole baton on one line; the caps and thickness never change.
  const bar =
    width === 0 || shown.length === 0
      ? BAR
      : Math.max(
          MIN_BAR,
          Math.min(BAR, (width - 2 * CAP - (shown.length + 1) * GAP) / shown.length),
        );
  const complete = orders.length > 0 && built === orders.length;
  const capClass = complete ? "bg-foreground" : "border border-foreground-tertiary";
  const label = [
    `${props.working} of ${props.crewCap} crew working`,
    `${built} of ${orders.length} built`,
    failed > 0 ? `${failed} failed` : null,
    props.paused ? "paused" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <View accessible accessibilityLabel={label} className="min-w-0 flex-1 gap-2">
      <View className="flex-row items-baseline gap-2">
        <Text textRole="title" className="font-t3-bold text-foreground tabular-nums">
          {built}
          <Text textRole="title" className="text-foreground-tertiary tabular-nums">
            /{orders.length}
          </Text>
        </Text>
        <HudLabel>{props.paused ? "built · paused" : "built"}</HudLabel>
        {failed > 0 ? (
          <HudLabel className="text-danger-foreground">{`${failed} failed`}</HudLabel>
        ) : null}
      </View>
      {shown.length === 0 ? null : (
        <View
          className="flex-row items-center"
          style={{ gap: GAP }}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        >
          <View
            className={capClass}
            style={{
              width: CAP,
              height: THICKNESS,
              borderTopLeftRadius: CAP_RADIUS,
              borderBottomLeftRadius: CAP_RADIUS,
            }}
          />
          {shown.map(({ id, material }) =>
            material === "scrapped" ? null : (
              <View
                key={id}
                className={cn(BLOCK_CLASS[material])}
                style={{ width: bar, height: THICKNESS }}
              />
            ),
          )}
          <View
            className={capClass}
            style={{
              width: CAP,
              height: THICKNESS,
              borderTopRightRadius: CAP_RADIUS,
              borderBottomRightRadius: CAP_RADIUS,
            }}
          />
          {orders.length > MAX_BLOCKS ? (
            <HudLabel className="ml-1">{`+${orders.length - MAX_BLOCKS}`}</HudLabel>
          ) : null}
        </View>
      )}
    </View>
  );
}
