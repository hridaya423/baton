import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import Constants from "expo-constants";
import { useRef, useState } from "react";
import { Platform, View, type ViewInstance } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { BatonMark } from "./BatonMark";
import { setLaunchTarget, useLaunchPhase } from "./baton/batonLaunchState";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";

const BRAND_MAX_FONT_SCALE = 1.4;

export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad && !NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? IPAD_HOME_TITLE_OFFSET : 0;
}

export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
    readonly accessibilityLabel?: string;
    /** Fills the row and hides the stage badge when the full title does not fit. */
    readonly fit?: boolean;
  } = {},
) {
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset = brandTitleOffset();
  const { scale } = useAndroidControlSizing();
  const launchPhase = useLaunchPhase();
  const mark = useRef<ViewInstance>(null);
  const markSize = Math.round(22 * scale);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  // Measured only while the badge shows, so hiding it does not make it look like it fits.
  const [fullWidth, setFullWidth] = useState<number | null>(null);
  const showStage =
    !props.fit || availableWidth === null || fullWidth === null || fullWidth <= availableWidth;

  const title = (
    <View
      onLayout={
        props.fit && showStage ? (event) => setFullWidth(event.nativeEvent.layout.width) : undefined
      }
      aria-level={1}
      accessibilityLabel={props.accessibilityLabel ?? "Baton, Threads"}
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={[
        { marginLeft: titleOffset },
        Platform.OS === "android" && { gap: 5.25 * scale },
        props.fit && { flexShrink: 0 },
      ]}
    >
      {/* The cold-launch mark lands here, so this one stays hidden until it has. */}
      <View
        ref={mark}
        style={{ opacity: launchPhase === "done" ? 1 : 0 }}
        onLayout={
          launchPhase === "done"
            ? undefined
            : () =>
                mark.current?.measureInWindow((x, y, width) =>
                  setLaunchTarget({ x, y, size: width }),
                )
        }
      >
        <BatonMark colorClassName="accent-icon" size={markSize} />
      </View>
      {/* A logo beside a fixed-size wordmark: it may grow with Dynamic Type, not crowd the bar. */}
      <Text
        allowFontScaling={props.allowFontScaling}
        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
        className="font-t3-bold text-foreground"
        style={{ fontSize: 21 * scale, letterSpacing: -0.6 * scale }}
      >
        Baton
      </Text>
      {showStage ? (
        <View
          className="rounded-full bg-subtle px-1.5 py-0.5"
          style={
            Platform.OS === "android"
              ? { paddingHorizontal: 5.25 * scale, paddingVertical: 1.75 * scale }
              : undefined
          }
        >
          <Text
            allowFontScaling={props.allowFontScaling}
            maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
            className="font-t3-bold text-foreground-muted"
            style={{ fontSize: 9 * scale }}
          >
            {stageLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return props.fit ? (
    <View
      className="min-w-0 flex-1 flex-row items-center"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      {title}
    </View>
  ) : (
    title
  );
}
