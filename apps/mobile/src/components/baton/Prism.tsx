import { useEffect, useId, useRef, useState } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

// A narrow dichroic band. Light mode stays near pastel so it reads as glass, not colour.
const PRISM_STOPS = {
  light: { colors: ["#86cfdc", "#a99de6", "#dc9fcf", "#e6c48c"], opacity: 0.85 },
  dark: { colors: ["#45e3ff", "#9d7dff", "#ff62d4", "#ffb84d"], opacity: 1 },
} as const;

/**
 * Baton's one accent: a prismatic band for the instant work is handed off or lands. Only for
 * glints, streaks and edges; never a fill, text or a large area.
 */
export function Prism(props: {
  readonly width: number | `${number}%`;
  readonly height: number;
  readonly vertical?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const id = `prism-${useId().replaceAll(":", "")}`;
  const stops = PRISM_STOPS[useAppearancePreferences().themeAppearance];
  return (
    <Svg
      pointerEvents="none"
      width={props.width}
      height={props.height}
      style={props.style}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <LinearGradient
          id={id}
          x1="0"
          y1="0"
          x2={props.vertical ? "0" : "1"}
          y2={props.vertical ? "1" : "0"}
        >
          <Stop offset="0" stopColor={stops.colors[0]} stopOpacity={0} />
          <Stop offset="0.15" stopColor={stops.colors[0]} stopOpacity={stops.opacity} />
          <Stop offset="0.38" stopColor={stops.colors[1]} stopOpacity={stops.opacity} />
          <Stop offset="0.62" stopColor={stops.colors[2]} stopOpacity={stops.opacity} />
          <Stop offset="0.85" stopColor={stops.colors[3]} stopOpacity={stops.opacity} />
          <Stop offset="1" stopColor={stops.colors[3]} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

export const PRISM_SWEEP_MS = 520;

/**
 * Runs a prism band once across its parent, left to right, each time `playKey` changes after
 * mount. Draws nothing at rest or when reduced motion is on.
 */
export function PrismSweep(props: {
  readonly playKey: number;
  readonly height: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly durationMs?: number;
  readonly delayMs?: number;
}) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [sweptKey, setSweptKey] = useState(props.playKey);
  const progress = useSharedValue(0);
  const bandWidth = Math.max(48, width * 0.45);
  const startedKey = useRef(props.playKey);
  const { durationMs = PRISM_SWEEP_MS, delayMs = 0 } = props;
  // The band mounts only for a sweep; until progress moves it sits clipped off the left edge.
  const sweeping = !reducedMotion && width > 0 && sweptKey !== props.playKey;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the one-shot Reanimated sweep when the moment it marks happens
  useEffect(() => {
    if (!sweeping || startedKey.current === props.playKey) return;
    const key = props.playKey;
    startedKey.current = key;
    progress.set(0);
    progress.set(
      withDelay(
        delayMs,
        withTiming(1, { duration: durationMs, easing: Easing.inOut(Easing.cubic) }, (finished) => {
          if (finished) runOnJS(setSweptKey)(key);
        }),
      ),
    );
  }, [sweeping, props.playKey, delayMs, durationMs, progress]);

  const bandStyle = useAnimatedStyle(() => ({
    opacity: progress.value < 0.85 ? 1 : (1 - progress.value) / 0.15,
    transform: [{ translateX: -bandWidth + progress.value * (width + bandWidth) }],
  }));

  return (
    <View
      pointerEvents="none"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      className="overflow-hidden"
      style={[{ height: props.height }, props.style]}
    >
      {sweeping ? (
        <Animated.View style={[{ width: bandWidth, height: props.height }, bandStyle]}>
          <Prism width={bandWidth} height={props.height} />
        </Animated.View>
      ) : null}
    </View>
  );
}
