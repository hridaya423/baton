import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { connectionPhaseTone } from "../connectionPhaseTone";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { StatusDot } from "../ui/status-dot";

// Rows read the phase alone, so a new attempt or route result does not re-render them.
const connectionPhaseAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.presentationAtom(environmentId))?.connection.phase ?? null,
  ),
);

/** A remote machine's icon, with a dot only while that machine is not connected. */
export function SidebarMachineIcon({
  environmentId,
  kind,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentMachineKind;
}) {
  const phase = useAtomValue(connectionPhaseAtom(environmentId));
  return (
    <span className="relative inline-flex shrink-0">
      <EnvironmentMachineIcon aria-hidden kind={kind} className="size-3.5" />
      {phase === null || phase === "connected" ? null : (
        <span
          role="img"
          aria-label={connectionStatusTitle({ phase, error: null, traceId: null })}
          className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full ring-1 ring-background"
        >
          <StatusDot tone={connectionPhaseTone(phase)} />
        </span>
      )}
    </span>
  );
}
