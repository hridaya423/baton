import { useNavigation } from "@react-navigation/native";
import { openCaptainEscalations } from "@t3tools/client-runtime/state/captainBoard";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useCaptainBoards } from "../../state/captains";
import { EscalationCard } from "./EscalationCard";

/** Every decision and approval a captain is waiting on, across environments, oldest first. */
export function NeedsYouScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const boards = useCaptainBoards();
  const items = [...boards].flatMap(([environmentId, board]) =>
    openCaptainEscalations(board).map((escalation) => ({
      environmentId,
      escalation,
      captainName: board.captains.get(escalation.captainId)?.name,
    })),
  );
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title="Needs you" onBack={() => navigation.goBack()} hideBottomBorder />
      <ScreenContent surface="screen">
        {items.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Nothing needs you"
            detail="When a captain needs a decision or an approval, it shows up here."
          />
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            showsVerticalScrollIndicator={false}
            className="flex-1"
            contentContainerClassName="gap-3 px-5 pt-4"
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          >
            {items.map((item) => (
              <EscalationCard
                key={`${item.environmentId}:${item.escalation.id}`}
                environmentId={item.environmentId}
                escalation={item.escalation}
                captainName={item.captainName}
              />
            ))}
          </ScrollView>
        )}
      </ScreenContent>
    </View>
  );
}
