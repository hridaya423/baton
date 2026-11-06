import { useNavigation } from "@react-navigation/native";
import { openCaptainEscalations } from "@t3tools/client-runtime/state/captainBoard";
import { View } from "react-native";
import Animated, { FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BatonWireframe } from "../../components/baton/BatonWireframe";
import { HudLabel } from "../../components/baton/HudLabel";
import { RollingCount } from "../../components/baton/RollingCount";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useCaptainBoards } from "../../state/captains";
import { EscalationCard } from "./EscalationCard";

const CARD_EXIT = FadeOut.duration(160).reduceMotion(ReduceMotion.System);
const CARD_LAYOUT = LinearTransition.springify()
  .damping(20)
  .stiffness(220)
  .reduceMotion(ReduceMotion.System);

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
            glyph={<BatonWireframe width={120} />}
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
            <View
              accessible
              accessibilityLabel={
                items.length === 1
                  ? "1 item waiting on you"
                  : `${items.length} items waiting on you`
              }
              className="flex-row items-baseline gap-2 px-1"
            >
              <RollingCount
                value={items.length}
                textRole="display"
                className="font-t3-bold text-warning-foreground"
              />
              <HudLabel>Waiting on you</HudLabel>
            </View>
            {items.map((item) => (
              <Animated.View
                key={`${item.environmentId}:${item.escalation.id}`}
                exiting={CARD_EXIT}
                layout={CARD_LAYOUT}
              >
                <EscalationCard
                  environmentId={item.environmentId}
                  escalation={item.escalation}
                  captainName={item.captainName}
                />
              </Animated.View>
            ))}
          </ScrollView>
        )}
      </ScreenContent>
    </View>
  );
}
