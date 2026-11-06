import type { ReactNode } from "react";
import { View } from "react-native";

import { cn } from "../../lib/cn";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";

/**
 * Four hues carry meaning and nothing else does: attention asks something of the user, danger
 * failed, progress is still moving, success finished. Everything else reads neutral.
 */
const TONES = {
  neutral: {
    fill: "bg-subtle-strong",
    text: "text-foreground-muted",
    tint: "accent-foreground-muted",
  },
  attention: {
    fill: "bg-adaptive-amber-500-a12-a16",
    text: "text-warning-foreground",
    tint: "accent-warning-foreground",
  },
  danger: {
    fill: "bg-adaptive-rose-500-a12-a16",
    text: "text-danger-foreground",
    tint: "accent-danger-foreground",
  },
  progress: {
    fill: "bg-adaptive-sky-500-a12-a16",
    text: "text-adaptive-sky-600-400",
    tint: "accent-adaptive-sky-600-400",
  },
  success: {
    fill: "bg-adaptive-emerald-500-a12-a16",
    text: "text-adaptive-emerald-700-300",
    tint: "accent-adaptive-emerald-700-300",
  },
} as const;

export type StatusBadgeTone = keyof typeof TONES;

/** The tone's text class, for a timer or count placed beside the badge label. */
export function statusBadgeTextClassName(tone: StatusBadgeTone): string {
  return TONES[tone].text;
}

export function StatusBadge(props: {
  readonly label: string;
  readonly tone?: StatusBadgeTone;
  readonly icon?: AppSymbolName;
  /** Drawn in place of `icon`, such as the working indicator. */
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  const tone = TONES[props.tone ?? "neutral"];
  return (
    <View
      className={cn("h-[18px] flex-row items-center gap-1 rounded-md px-1.5", tone.fill)}
      style={{ borderCurve: "continuous" }}
    >
      {props.leading ??
        (props.icon ? (
          <SymbolView
            name={props.icon}
            size={10}
            tintColorClassName={tone.tint}
            type="monochrome"
          />
        ) : null)}
      <Text className={cn("text-xs font-t3-medium tabular-nums", tone.text)}>{props.label}</Text>
      {props.trailing}
    </View>
  );
}
