import type { CaptainBoardColumns } from "@t3tools/client-runtime/state/captainBoard";
import { View } from "react-native";

import { HudLabel } from "../../components/baton/HudLabel";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { orderMaterial, type OrderMaterial } from "./orderMaterial";

const MAX_BLOCKS = 12;

const BLOCK_CLASS: Record<Exclude<OrderMaterial, "scrapped">, string> = {
  planned: "border border-dashed border-foreground-tertiary",
  building: "border border-foreground-muted",
  checking: "border border-foreground-muted",
  built: "bg-foreground",
  landed: "bg-foreground",
};

/** A captain's orders as blocks: built ones solid, the rest outlined. The text stays for screen readers. */
export function CrewStack(props: {
  readonly columns: CaptainBoardColumns["columns"];
  readonly working: number;
  readonly crewCap: number;
  readonly paused: boolean;
}) {
  const materials = [
    ...props.columns.done,
    ...props.columns["needs-you"],
    ...props.columns.checking,
    ...props.columns.running,
    ...props.columns.queued,
  ].map((order) => ({ id: order.id, material: orderMaterial(order.state) }));
  const built = materials.filter(({ material }) => material === "built" || material === "landed");
  const shown = materials.slice(0, MAX_BLOCKS);
  const label = `${props.working} of ${props.crewCap} crew working, ${built.length} of ${materials.length} built${props.paused ? ", paused" : ""}`;
  return (
    <View accessible accessibilityLabel={label} className="min-w-0 flex-1 gap-1.5">
      <View className="flex-row items-baseline gap-2">
        <Text textRole="title" className="font-t3-bold text-foreground tabular-nums">
          {built.length}
          <Text textRole="title" className="text-foreground-tertiary tabular-nums">
            /{materials.length}
          </Text>
        </Text>
        <HudLabel>{props.paused ? "Built · paused" : "Built"}</HudLabel>
      </View>
      {shown.length === 0 ? null : (
        <View className="flex-row flex-wrap items-center gap-1">
          {shown.map(({ id, material }) =>
            material === "scrapped" ? null : (
              <View key={id} className={cn("h-3.5 w-2.5 rounded-[2px]", BLOCK_CLASS[material])} />
            ),
          )}
          {materials.length > MAX_BLOCKS ? (
            <HudLabel className="ml-1">{`+${materials.length - MAX_BLOCKS}`}</HudLabel>
          ) : null}
        </View>
      )}
    </View>
  );
}
