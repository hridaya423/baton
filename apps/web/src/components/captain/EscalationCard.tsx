import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CaptainEscalation, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { captainEnvironment } from "../../state/captains";
import { useAtomCommand } from "../../state/use-atom-command";
import { ESCALATION_KIND_LABELS } from "./captainLabels";

const MAX_ANSWER_CHARS = 2_000;

/** A needs-you item with its choices. Answering resolves it, and the board stream drops the card. */
export function EscalationCard(props: {
  environmentId: EnvironmentId;
  escalation: CaptainEscalation;
  captainName?: string | undefined;
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
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not send the answer.");
  };

  return (
    <section
      aria-label={escalation.summary}
      data-testid="captain-escalation-card"
      className="flex flex-col gap-2 rounded-card border border-border bg-card p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant={isApproval || escalation.kind === "one_way_door" ? "warning" : "info"}>
          {ESCALATION_KIND_LABELS[escalation.kind]}
        </Badge>
        {props.captainName === undefined ? null : (
          <Text variant="meta" tone="muted" truncate>
            {props.captainName}
          </Text>
        )}
      </div>
      <Text variant="label" render={<p />}>
        {escalation.summary}
      </Text>
      {escalation.detail.trim().length === 0 ? null : (
        <Text variant="body" tone="muted" render={<p className="whitespace-pre-wrap" />}>
          {escalation.detail}
        </Text>
      )}
      <div className="flex flex-wrap gap-2">
        {isApproval ? (
          <>
            <Button
              size="compact"
              disabled={!canResolve || pending}
              onClick={() => void send("Approve")}
            >
              Approve
            </Button>
            <Button
              size="compact"
              variant="destructive-outline"
              disabled={!canResolve || pending}
              onClick={() => void send("Deny")}
            >
              Deny
            </Button>
          </>
        ) : (
          escalation.options.map((option) => (
            <Button
              key={option}
              size="compact"
              variant="secondary"
              disabled={!canResolve || pending}
              onClick={() => void send(option)}
            >
              {option}
            </Button>
          ))
        )}
      </div>
      {isApproval ? null : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(answer);
          }}
        >
          <Input
            aria-label="Your answer"
            placeholder="Or answer in your own words"
            value={answer}
            maxLength={MAX_ANSWER_CHARS}
            disabled={!canResolve || pending}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button
            type="submit"
            size="compact"
            disabled={!canResolve || pending || answer.trim().length === 0}
          >
            Send
          </Button>
        </form>
      )}
      {error === null ? null : (
        <Text variant="meta" tone="destructive" render={<p role="alert" />}>
          {error}
        </Text>
      )}
    </section>
  );
}
