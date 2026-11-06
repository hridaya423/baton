import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

type IosHaptic =
  | { readonly kind: "impact"; readonly style: Haptics.ImpactFeedbackStyle }
  | { readonly kind: "notification"; readonly type: Haptics.NotificationFeedbackType };

/**
 * Baton's haptics, one per moment. Android goes through `performHapticFeedback`, which honours the
 * system touch-feedback setting; the Vibrator path behind `impactAsync` would not.
 */
const HAPTICS = {
  send: {
    ios: { kind: "impact", style: Haptics.ImpactFeedbackStyle.Medium },
    android: Haptics.AndroidHaptics.Context_Click,
  },
  land: {
    ios: { kind: "notification", type: Haptics.NotificationFeedbackType.Success },
    android: Haptics.AndroidHaptics.Confirm,
  },
  drop: {
    ios: { kind: "impact", style: Haptics.ImpactFeedbackStyle.Rigid },
    android: Haptics.AndroidHaptics.Reject,
  },
  decide: {
    ios: { kind: "impact", style: Haptics.ImpactFeedbackStyle.Light },
    android: Haptics.AndroidHaptics.Virtual_Key,
  },
  needsYou: {
    ios: { kind: "notification", type: Haptics.NotificationFeedbackType.Warning },
    android: Haptics.AndroidHaptics.Long_Press,
  },
  makeCaptain: {
    ios: { kind: "impact", style: Haptics.ImpactFeedbackStyle.Heavy },
    android: Haptics.AndroidHaptics.Long_Press,
  },
} as const satisfies Record<
  string,
  { readonly ios: IosHaptic; readonly android: Haptics.AndroidHaptics }
>;

export type BatonHaptic = keyof typeof HAPTICS;

export function playHaptic(moment: BatonHaptic): void {
  const haptic = HAPTICS[moment];
  const played =
    Platform.OS === "android"
      ? Haptics.performAndroidHapticsAsync(haptic.android)
      : haptic.ios.kind === "impact"
        ? Haptics.impactAsync(haptic.ios.style)
        : Haptics.notificationAsync(haptic.ios.type);
  // Haptics are a garnish; a device without an engine must not surface an error.
  played.catch(() => {});
}
