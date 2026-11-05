import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { useCaptainNeedsYou, useCaptainOfThread } from "../../state/captains";

/** On a captain's own thread: the crew board, or the Needs-you list while the crew waits on the user. */
export function CaptainThreadBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const captain = useCaptainOfThread(props.environmentId, props.threadId);
  const needsYou = useCaptainNeedsYou(props.environmentId, props.threadId);
  if (captain === null) return null;
  const label =
    needsYou === 0
      ? "Crew board"
      : needsYou === 1
        ? "1 item needs you"
        : `${needsYou} items need you`;
  const open = () =>
    needsYou === 0
      ? navigation.navigate("CaptainBoard", {
          environmentId: props.environmentId,
          threadId: props.threadId,
        })
      : navigation.navigate("NeedsYou");
  return (
    <View className="px-4 pb-2">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        className={
          needsYou === 0
            ? "rounded-2xl border-continuous bg-grouped-card"
            : "rounded-2xl border-continuous bg-adaptive-amber-500-a12-a16"
        }
        onPress={open}
      >
        <View className="min-h-11 flex-row items-center gap-3 px-4 py-2">
          <SymbolView
            name={needsYou === 0 ? "person.2" : "bell.badge"}
            size={16}
            tintColorClassName={
              needsYou === 0 ? "accent-foreground-muted" : "accent-warning-foreground"
            }
            type="monochrome"
          />
          <Text
            textRole="body"
            className={
              needsYou === 0
                ? "min-w-0 flex-1 font-t3-medium text-foreground"
                : "min-w-0 flex-1 font-t3-medium text-warning-foreground"
            }
          >
            {label}
          </Text>
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName={
              needsYou === 0 ? "accent-foreground-muted" : "accent-warning-foreground"
            }
            type="monochrome"
            weight="semibold"
          />
        </View>
      </RowPressable>
    </View>
  );
}
