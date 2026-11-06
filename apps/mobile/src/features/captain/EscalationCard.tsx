import { useAtomValue } from "@effect/atom-react";
import { ESCALATION_KIND_LABELS } from "@t3tools/client-runtime/state/captainPresentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CaptainEscalation, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { playHaptic } from "../../lib/haptics";
import { captainEnvironment } from "../../state/captains";
import { useAtomCommand } from "../../state/use-atom-command";

const MAX_ANSWER_CHARS = 2_000;

/** A needs-you item with its choices. Answering resolves it, and the board stream drops the card. */
export function EscalationCard(props: {
  readonly environmentId: EnvironmentId;
  readonly escalation: CaptainEscalation;
  readonly captainName?: string | undefined;
}) {
  const { environmentId, escalation } = props;
  const resolve = useAtomCommand(captainEnvironment.resolveEscalation, { reportFailure: false });
  const canResolve = useAtomValue(
    captainEnvironment.resolveEscalation.permissionAtom(environmentId),
  );
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isApproval = escalation.kind === "approval";
  const blocked = !canResolve || pending;

  const send = async (resolution: string) => {
    const trimmed = resolution.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setError(null);
    const result = await resolve({
      environmentId,
      input: { escalationId: escalation.id, resolution: trimmed },
    });
    setPending(false);
    if (result._tag === "Success") {
      playHaptic("decide");
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not send the answer.");
  };

  return (
    <View
      accessible={false}
      className="gap-3 rounded-2xl border border-border border-continuous bg-grouped-card p-4"
      testID="captain-escalation-card"
    >
      <View className="flex-row items-center gap-2">
        <StatusBadge label={ESCALATION_KIND_LABELS[escalation.kind]} tone="attention" />
        {props.captainName === undefined ? null : (
          <Text textRole="label" className="min-w-0 shrink text-foreground-muted" numberOfLines={1}>
            {props.captainName}
          </Text>
        )}
      </View>
      <Text textRole="body" className="font-t3-medium">
        {escalation.summary}
      </Text>
      {escalation.detail.trim().length === 0 ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {escalation.detail}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        {isApproval ? (
          <>
            <Button
              label="Approve"
              tone="primary"
              size="compact"
              disabled={blocked}
              onPress={() => void send("Approve")}
            />
            <Button
              label="Deny"
              tone="danger"
              size="compact"
              disabled={blocked}
              onPress={() => void send("Deny")}
            />
          </>
        ) : (
          escalation.options.map((option) => (
            <Button
              key={option}
              label={option}
              tone="secondary"
              size="compact"
              disabled={blocked}
              onPress={() => void send(option)}
            />
          ))
        )}
      </View>
      {isApproval ? null : (
        <View className="flex-row items-center gap-2">
          <AppTextInput
            accessibilityLabel="Your answer"
            className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
            placeholder="Or answer in your own words"
            value={answer}
            maxLength={MAX_ANSWER_CHARS}
            editable={!blocked}
            returnKeyType="send"
            onChangeText={setAnswer}
            onSubmitEditing={() => void send(answer)}
          />
          <Button
            label="Send"
            tone="secondary"
            size="compact"
            disabled={blocked || answer.trim().length === 0}
            onPress={() => void send(answer)}
          />
        </View>
      )}
      {error === null ? null : (
        <Text textRole="footnote" className="text-danger-foreground" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}
