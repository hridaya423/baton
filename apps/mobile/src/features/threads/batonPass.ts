import { Easing, withTiming } from "react-native-reanimated";
import type { EntryAnimationsValues, LayoutAnimation } from "react-native-reanimated";

import { readReduceMotionEnabled } from "../../lib/appState";

const PASS_MS = 280;
const PASS_WINDOW_MS = 1_500;

let pass: { readonly fromY: number; readonly at: number } | null = null;

/** Notes where the composer's text sat when the user sent, so the new bubble can lift from there. */
export function recordBatonPass(fromY: number, nowMs = Date.now()) {
  pass = { fromY, at: nowMs };
}

/**
 * The entering animation for a user bubble created at `createdAtMs` when it is the one just sent:
 * it rises from the composer to its place. Undefined otherwise, so callers keep their own entrance.
 */
export function batonPassEntering(
  createdAtMs: number,
  nowMs = Date.now(),
): ((values: EntryAnimationsValues) => LayoutAnimation) | undefined {
  const current = pass;
  if (
    current === null ||
    nowMs - current.at > PASS_WINDOW_MS ||
    Math.abs(createdAtMs - current.at) > PASS_WINDOW_MS ||
    readReduceMotionEnabled()
  ) {
    return undefined;
  }
  const fromY = current.fromY;
  return (values) => {
    "worklet";
    const timing = { duration: PASS_MS, easing: Easing.out(Easing.cubic) };
    return {
      initialValues: {
        opacity: 0.5,
        transform: [{ translateY: fromY - values.targetGlobalOriginY }, { scale: 0.97 }],
      },
      animations: {
        opacity: withTiming(1, timing),
        transform: [{ translateY: withTiming(0, timing) }, { scale: withTiming(1, timing) }],
      },
    };
  };
}
