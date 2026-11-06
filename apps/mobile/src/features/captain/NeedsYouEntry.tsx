import { countOpenCaptainEscalations } from "@t3tools/client-runtime/state/captainPresentation";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { RollingCount } from "../../components/baton/RollingCount";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { isAppActive } from "../../lib/appState";
import { playHaptic } from "../../lib/haptics";
import { useCaptainBoards } from "../../state/captains";
import { shouldAnnounceNeedsYou } from "./needsYouAnnouncement";

/** The way into the Needs-you list, shown above the threads while a captain is waiting on the user. */
export function NeedsYouEntry() {
  const navigation = useNavigation();
  const { open } = countOpenCaptainEscalations(useCaptainBoards());
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  const previous = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pulses the badge once and plays the warning haptic when a new item arrives
  useEffect(() => {
    const before = previous.current;
    previous.current = open;
    if (!shouldAnnounceNeedsYou(before, open)) return;
    if (isAppActive()) playHaptic("needsYou");
    if (reducedMotion) return;
    pulse.set(
      withSequence(
        withTiming(1, { duration: 140 }),
        withSpring(0, { damping: 12, stiffness: 180 }),
      ),
    );
  }, [open, pulse, reducedMotion]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 1 - pulse.value * 0.25,
    transform: [{ scale: 1 + pulse.value * 0.18 }],
  }));

  if (open === 0) return null;
  const label = open === 1 ? "1 item needs you" : `${open} items need you`;
  return (
    <View className="px-3 pb-1 pt-2">
      <View className="overflow-hidden rounded-2xl border-continuous bg-warning">
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Opens the decisions and approvals your captains are waiting on"
          onPress={() => navigation.navigate("NeedsYou")}
        >
          <View className="min-h-12 flex-row items-center gap-3 px-4 py-2.5">
            <SymbolView
              name="bell.badge"
              size={18}
              tintColorClassName="accent-warning-foreground"
              type="monochrome"
            />
            <Text textRole="body" className="min-w-0 flex-1 font-t3-medium text-warning-foreground">
              Needs you
            </Text>
            <Animated.View
              className="min-w-6 items-center rounded-full bg-adaptive-amber-500-a12-a16 px-2"
              style={pulseStyle}
            >
              <RollingCount
                value={open}
                textRole="headline"
                className="font-t3-bold text-warning-foreground"
              />
            </Animated.View>
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-warning-foreground"
              type="monochrome"
              weight="semibold"
            />
          </View>
        </RowPressable>
      </View>
    </View>
  );
}
