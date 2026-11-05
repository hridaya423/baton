import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBarInset } from "../../../components/ui/useBarInset";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../../native/native-glass";

/** A workspace list scrolls under its bar where the bar is glass; under a solid bar it starts below. */
export const WORKSPACE_LIST_SCROLL_INSETS = {
  automaticallyAdjustsScrollIndicatorInsets: NATIVE_LIQUID_GLASS_SUPPORTED,
  contentInsetAdjustmentBehavior: NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never",
} as const;

/** How far an empty workspace list keeps its message below a glass bar and its search. */
export function useWorkspaceListEmptyTopInset(): number {
  const insets = useSafeAreaInsets();
  return NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0;
}

/** Where a workspace list's rows start under a glass bar: the bar's height, or 0 under a solid bar. */
export function useWorkspaceListBarInset(): number {
  const barInset = useBarInset();
  return NATIVE_LIQUID_GLASS_SUPPORTED ? barInset : 0;
}
