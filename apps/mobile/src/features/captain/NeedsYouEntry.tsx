import { countOpenCaptainEscalations } from "@t3tools/client-runtime/state/captainPresentation";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { useCaptainBoards } from "../../state/captains";

/** The way into the Needs-you list, shown above the threads while a captain is waiting on the user. */
export function NeedsYouEntry() {
  const navigation = useNavigation();
  const { open } = countOpenCaptainEscalations(useCaptainBoards());
  if (open === 0) return null;
  const label = open === 1 ? "1 item needs you" : `${open} items need you`;
  return (
    <View className="px-3 pb-1 pt-2">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens the decisions and approvals your captains are waiting on"
        className="rounded-2xl border border-warning-border border-continuous bg-warning"
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
            {label}
          </Text>
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
  );
}
