import { useEffect, useRef, useState } from "react";
import { StyleSheet, View, type ViewInstance } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { BATON_BLOCK_PATHS, BATON_MARK_ROTATION } from "../BatonMark";
import {
  LAUNCH_HANDOFF_AT_MS,
  beginLaunch,
  finishLaunch,
  launchTarget,
  useLaunchPhase,
} from "./batonLaunchState";
import { Prism } from "./Prism";

const AnimatedPath = Animated.createAnimatedComponent(Path);

const MARK_SIZE = 96;
const FIRST_BLOCK_AT_MS = 120;
const BLOCK_STAGGER_MS = 70;
const BLOCK_SPRING = { damping: 16, stiffness: 190, mass: 0.8 } as const;
const GLINT_AT_MS = 520;
const GLINT_MS = 380;
const HANDOFF_SPRING = { damping: 22, stiffness: 170, mass: 0.9 } as const;
const BACKDROP_FADE_MS = 320;
const BAR = { x: 7, y: 9, width: 10, height: 6 } as const;

/**
 * Cold launch: the splash gives way to the mark as hairlines, its blocks fill one after another, a
 * glint crosses the bar, and the mark moves into the header's mark. Once per JS runtime; skipped
 * with reduced motion.
 */
export function BatonLaunch() {
  const { isReady } = useAppearancePreferences();
  const phase = useLaunchPhase();
  const reducedMotion = useReducedMotion();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the launch done without playing it when reduced motion is on
  useEffect(() => {
    if (isReady && reducedMotion) finishLaunch();
  }, [isReady, reducedMotion]);

  if (!isReady || reducedMotion || phase === "done") return null;
  return <LaunchOverlay />;
}

function LaunchBlock(props: { readonly d: string; readonly fill: SharedValue<number> }) {
  const animatedProps = useAnimatedProps(() => ({ fillOpacity: props.fill.value }));
  return <AnimatedPath d={props.d} fill="currentColor" animatedProps={animatedProps} />;
}

function LaunchOverlay() {
  const theme = useAppearancePreferences().themeVariables;
  const overlay = useRef<ViewInstance>(null);
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const block0 = useSharedValue(0);
  const block1 = useSharedValue(0);
  const block2 = useSharedValue(0);
  const glint = useSharedValue(0);
  const backdrop = useSharedValue(1);
  const markOpacity = useSharedValue(1);
  const travelX = useSharedValue(0);
  const travelY = useSharedValue(0);
  const scale = useSharedValue(1);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the one-shot launch timeline once the overlay knows where it sits
  useEffect(() => {
    if (frame === null) return;
    beginLaunch(Date.now());
    [block0, block1, block2].forEach((fill, index) =>
      fill.set(
        withDelay(FIRST_BLOCK_AT_MS + index * BLOCK_STAGGER_MS, withSpring(1, BLOCK_SPRING)),
      ),
    );
    glint.set(
      withDelay(
        GLINT_AT_MS,
        withTiming(1, { duration: GLINT_MS, easing: Easing.inOut(Easing.cubic) }),
      ),
    );
    const handoff = setTimeout(() => {
      const done = () => finishLaunch();
      backdrop.set(withTiming(0, { duration: BACKDROP_FADE_MS }));
      const target = launchTarget();
      if (target === null) {
        markOpacity.set(
          withTiming(0, { duration: BACKDROP_FADE_MS }, (finished) => {
            if (finished) runOnJS(done)();
          }),
        );
        return;
      }
      travelX.set(withSpring(target.x + target.size / 2 - (frame.x + frame.w / 2), HANDOFF_SPRING));
      travelY.set(withSpring(target.y + target.size / 2 - (frame.y + frame.h / 2), HANDOFF_SPRING));
      scale.set(
        withSpring(target.size / MARK_SIZE, HANDOFF_SPRING, (finished) => {
          if (finished) runOnJS(done)();
        }),
      );
    }, LAUNCH_HANDOFF_AT_MS);
    return () => clearTimeout(handoff);
  }, [frame, block0, block1, block2, glint, backdrop, markOpacity, travelX, travelY, scale]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [
      { translateX: travelX.value },
      { translateY: travelY.value },
      { scale: scale.value },
    ],
  }));
  const unit = MARK_SIZE / 24;
  const glintWidth = BAR.width * unit * 0.9;
  const glintStyle = useAnimatedStyle(() => ({
    opacity: glint.value === 0 || glint.value === 1 ? 0 : 1,
    transform: [{ translateX: -glintWidth + glint.value * (BAR.width * unit + glintWidth) }],
  }));

  const color = theme["--color-icon"];
  return (
    <View
      ref={overlay}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={() =>
        overlay.current?.measureInWindow((x, y, w, h) =>
          setFrame((current) => current ?? { x, y, w, h }),
        )
      }
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme["--color-screen"] },
          backdropStyle,
        ]}
      />
      <View style={StyleSheet.absoluteFill} className="items-center justify-center">
        <Animated.View style={[{ width: MARK_SIZE, height: MARK_SIZE }, markStyle]}>
          <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox="0 0 24 24" color={color}>
            <G transform={BATON_MARK_ROTATION}>
              <Path
                d={BATON_BLOCK_PATHS.join("")}
                fill="none"
                stroke="currentColor"
                strokeWidth={0.12}
              />
              {BATON_BLOCK_PATHS.map((d, index) => (
                <LaunchBlock key={d} d={d} fill={[block0, block1, block2][index]!} />
              ))}
            </G>
          </Svg>
          <View
            style={[StyleSheet.absoluteFill, { transform: [{ rotate: "-45deg" }] }]}
            pointerEvents="none"
          >
            <View
              className="overflow-hidden"
              style={{
                position: "absolute",
                left: BAR.x * unit,
                top: BAR.y * unit,
                width: BAR.width * unit,
                height: BAR.height * unit,
              }}
            >
              <Animated.View style={[{ width: glintWidth, height: BAR.height * unit }, glintStyle]}>
                <Prism width={glintWidth} height={BAR.height * unit} />
              </Animated.View>
            </View>
          </View>
        </Animated.View>
      </View>
    </View>
  );
}
