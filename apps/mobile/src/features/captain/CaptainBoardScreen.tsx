import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  captainBoardColumns,
  captainBoardSections,
  openEscalationsByOrder,
} from "@t3tools/client-runtime/state/captainBoard";
import { BOARD_COLUMN_LABELS } from "@t3tools/client-runtime/state/captainPresentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BatonWireframe } from "../../components/baton/BatonWireframe";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { captainEnvironment, useCaptainBoard } from "../../state/captains";
import { useAtomCommand } from "../../state/use-atom-command";
import { CrewStack } from "./CrewStack";
import { EscalationCard } from "./EscalationCard";
import { OrderRow } from "./OrderRow";

export type CaptainBoardParams = {
  readonly environmentId: string;
  readonly threadId: string;
};

/** A captain's crew as a list: what needs the user first, then what is in flight, then what is done. */
export function CaptainBoardScreen({ route }: StaticScreenProps<CaptainBoardParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const board = useCaptainBoard(environmentId);
  const updateCaptain = useAtomCommand(captainEnvironment.updateCaptain, { reportFailure: false });
  const canUpdate = useAtomValue(captainEnvironment.updateCaptain.permissionAtom(environmentId));
  const [showDropped, setShowDropped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captain =
    [...board.captains.values()].find(
      (candidate) => candidate.threadId === threadId && candidate.status !== "released",
    ) ?? null;

  const columns = captain === null ? null : captainBoardColumns(board, captain.id);
  const sections = columns === null ? [] : captainBoardSections(columns);
  const escalationsByOrder = openEscalationsByOrder(board.escalations.values());
  const paused = captain?.status === "paused";
  const working =
    columns === null ? 0 : columns.columns.running.length + columns.columns.checking.length;

  const toggleStatus = async () => {
    if (captain === null) return;
    setError(null);
    const result = await updateCaptain({
      environmentId,
      input: { captainId: captain.id, status: paused ? "active" : "paused" },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not update the captain.");
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={captain === null ? "Crew board" : captain.name}
        subtitle={captain === null ? null : "Crew board"}
        onBack={() => navigation.goBack()}
        hideBottomBorder
      />
      <ScreenContent surface="screen">
        {captain === null || columns === null ? (
          <EmptyState
            variant="plain"
            title={board.loaded ? "This thread is not a captain" : "Loading the board"}
            detail={
              board.loaded
                ? "Make captain from the thread menu to hand work to a crew."
                : "One moment."
            }
          />
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            showsVerticalScrollIndicator={false}
            className="flex-1"
            contentContainerClassName="gap-5 px-5 pt-4"
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          >
            <View className="gap-3">
              <View className="flex-row items-end gap-3">
                <CrewStack
                  columns={columns.columns}
                  working={working}
                  crewCap={captain.charter.crewCap}
                  paused={paused}
                />
                <Button
                  label={paused ? "Resume" : "Pause"}
                  tone="secondary"
                  size="compact"
                  disabled={!canUpdate}
                  onPress={() => void toggleStatus()}
                />
              </View>
              {error === null ? null : (
                <Text
                  textRole="footnote"
                  className="text-danger-foreground"
                  accessibilityRole="alert"
                >
                  {error}
                </Text>
              )}
            </View>
            {sections.length === 0 && columns.dropped.length === 0 ? (
              <EmptyState
                variant="plain"
                glyph={<BatonWireframe width={120} />}
                title="No orders yet"
                detail="Ask the captain for work and its crew appears here."
              />
            ) : null}
            {sections.map((section) => (
              <View
                key={section.column}
                className="gap-2"
                accessibilityLabel={BOARD_COLUMN_LABELS[section.column]}
              >
                <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
                  {BOARD_COLUMN_LABELS[section.column]} ·{" "}
                  {section.orders.length + section.looseEscalations.length}
                </Text>
                {section.looseEscalations.map((escalation) => (
                  <EscalationCard
                    key={escalation.id}
                    environmentId={environmentId}
                    escalation={escalation}
                  />
                ))}
                {section.orders.map((order) => (
                  <OrderRow
                    key={order.id}
                    environmentId={environmentId}
                    captain={captain}
                    order={order}
                    escalations={escalationsByOrder.get(order.id) ?? []}
                  />
                ))}
              </View>
            ))}
            {columns.dropped.length === 0 ? null : (
              <View className="gap-2">
                <Button
                  label={showDropped ? "Hide dropped" : `Show dropped (${columns.dropped.length})`}
                  tone="text"
                  size="compact"
                  onPress={() => setShowDropped((current) => !current)}
                />
                {showDropped
                  ? columns.dropped.map((order) => (
                      <OrderRow
                        key={order.id}
                        environmentId={environmentId}
                        captain={captain}
                        order={order}
                        escalations={[]}
                      />
                    ))
                  : null}
              </View>
            )}
          </ScrollView>
        )}
      </ScreenContent>
    </View>
  );
}
