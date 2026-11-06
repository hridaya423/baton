import type { CaptainCrewDot } from "@t3tools/client-runtime/state/captainBoard";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { cn } from "../../lib/cn";
import { useCaptainCrew, useCaptainNeedsYou, useCaptainOfThread } from "../../state/captains";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";

const DOT_CLASS: Record<CaptainCrewDot, string> = {
  running: "bg-adaptive-sky-600-400",
  "needs-you": "bg-adaptive-amber-700-400",
  done: "bg-adaptive-emerald-600-400",
};

const DOT_LABEL: Record<CaptainCrewDot, string> = {
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
};

/** The anchor that marks a captain's thread in a list. */
export function CaptainGlyph(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly size: number;
  readonly tintClassName: string;
}) {
  const captain = useCaptainOfThread(props.environmentId, props.threadId);
  if (captain === null) return null;
  return (
    <SymbolView
      name="anchor"
      size={props.size}
      tintColorClassName={props.tintClassName}
      type="monochrome"
      accessibilityLabel="Captain"
    />
  );
}

/** How many of a captain's items wait on the user. */
export function CaptainNeedsYouBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const count = useCaptainNeedsYou(props.environmentId, props.threadId);
  if (count === 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={count === 1 ? "1 item needs you" : `${count} items need you`}
    >
      <StatusBadge label={`${count} needs you`} tone="attention" />
    </View>
  );
}

/** A captain's crew, nested under its row on a connector line: one line each, with a dot for where it stands. */
export function CaptainCrewRail(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly leftInset: number;
  readonly textClassName: string;
}) {
  const crew = useCaptainCrew(props.environmentId, props.threadId);
  const openDetail = useOpenWorkspaceDetail();
  if (crew.length === 0) return null;
  return (
    <View className="mt-1 flex-row" style={{ paddingLeft: props.leftInset }}>
      <View className="mr-1 w-px self-stretch rounded-full bg-border" />
      <View className="min-w-0 flex-1 gap-0.5">
        {crew.map((entry) => (
          <Pressable
            key={entry.order.id}
            accessibilityRole="button"
            accessibilityLabel={`${entry.order.title}, ${DOT_LABEL[entry.dot]}`}
            // Padding cancelled by negative margin grows the touch target without moving the line.
            className="-my-1 flex-row items-center gap-2 py-1.5 pl-2.5"
            onPress={() =>
              openDetail({
                name: "Thread",
                params: {
                  environmentId: entry.order.environmentId ?? props.environmentId,
                  threadId: entry.threadId,
                },
              })
            }
            // Handle long-press so opening the iOS row menu cannot also open the crew thread.
            onLongPress={() => undefined}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <View className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[entry.dot])} />
            <Text className={cn("min-w-0 flex-1 text-xs", props.textClassName)} numberOfLines={1}>
              {entry.order.title}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
