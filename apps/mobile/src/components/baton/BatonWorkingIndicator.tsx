import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Animated as NativeAnimated, Easing, useAnimatedValue, View } from "react-native";

import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";

const CYCLE_MS = 1_200;
const REST_OPACITY = 0.28;
// Cap, bar, cap in mark units; the mark is 21.2 long and 6 thick with 1.2 gaps.
const BLOCKS = [
  { key: "cap-start", length: 4.4 },
  { key: "bar", length: 10 },
  { key: "cap-end", length: 4.4 },
] as const;
const GAP = 1.2;
const LENGTH = 21.2;
const THICKNESS = 6;

function blockOpacity(progress: NativeAnimated.Value, index: number) {
  const start = index * 0.22;
  return progress.interpolate({
    inputRange: [0, start, start + 0.18, start + 0.42, 1],
    outputRange: [REST_OPACITY, REST_OPACITY, 1, REST_OPACITY, REST_OPACITY],
    extrapolate: "clamp",
  });
}

/**
 * The mark's three blocks lighting in sequence: Baton's only looping animation. It animates opacity
 * on the native driver, not Reanimated (docs/internals/performance-regressions.md), and stops when
 * the screen loses focus, the app leaves the foreground, or reduced motion is on.
 */
export function BatonWorkingIndicator(props: {
  readonly size: number;
  readonly blockClassName: string;
}) {
  const appIsActive = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const screenIsFocused = useIsFocused();
  const progress = useAnimatedValue(0);
  const [opacities] = useState(() => [0, 1, 2].map((index) => blockOpacity(progress, index)));
  const running = appIsActive && !reducedMotion && screenIsFocused;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the native-driver loop while visible and active, and stops it on cleanup
  useEffect(() => {
    progress.setValue(running ? 0 : 0.3);
    if (!running) return;
    const loop = NativeAnimated.loop(
      NativeAnimated.timing(progress, {
        toValue: 1,
        duration: CYCLE_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, running]);

  const unit = (props.size * 0.8) / LENGTH;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center"
      style={{ width: props.size, height: props.size }}
    >
      <View className="flex-row" style={{ gap: GAP * unit, transform: [{ rotate: "-45deg" }] }}>
        {BLOCKS.map(({ key, length }, index) => (
          <NativeAnimated.View
            key={key}
            style={{
              overflow: "hidden",
              width: length * unit,
              height: THICKNESS * unit,
              opacity: opacities[index],
              borderTopLeftRadius: index === 0 ? unit * 1.2 : 0,
              borderBottomLeftRadius: index === 0 ? unit * 1.2 : 0,
              borderTopRightRadius: index === 2 ? unit * 1.2 : 0,
              borderBottomRightRadius: index === 2 ? unit * 1.2 : 0,
            }}
          >
            <View className={`flex-1 ${props.blockClassName}`} />
          </NativeAnimated.View>
        ))}
      </View>
    </View>
  );
}
