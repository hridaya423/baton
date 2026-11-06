import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useStableCallback } from "../hooks/useStableCallback";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { CommandBlock } from "./CommandBlock";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  collectProviderUpdateCandidates,
  getProviderUpdateManualReason,
  getProviderUpdateToastView,
  isProviderUpdateActive,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { toastManager } from "./ui/toast";

interface Notice {
  readonly id: ReturnType<typeof toastManager.add>;
  readonly instanceId: ProviderInstanceId;
}

/** What this client did for a notice; null means the request itself has not failed. */
type NoticeRun = { readonly requestFailure: string | null };

/** Announce each available provider version once per client session, and run its update in place. */
export function ProviderUpdateLaunchNotification() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = usePrimaryEnvironmentId();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const shown = useRef(new Set<string>());
  const notices = useRef(new Map<string, Notice>());
  const activeSeen = useRef(new Set<string>());
  const [runs, setRuns] = useState<ReadonlyMap<string, NoticeRun>>(() => new Map());

  const runUpdate = useStableCallback(async (key: string) => {
    const instanceId = notices.current.get(key)?.instanceId;
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (!environmentId || !provider || isProviderUpdateActive(provider)) return;
    setRuns((previous) => new Map(previous).set(key, { requestFailure: null }));
    const result = await updateProvider({
      environmentId,
      input: { provider: provider.driver, instanceId: provider.instanceId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const requestFailure =
        error instanceof Error ? error.message : "The update could not be started.";
      setRuns((previous) => new Map(previous).set(key, { requestFailure }));
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles server version advisories with the external toast manager
  useEffect(() => {
    const viewFor = (provider: ServerProvider, key: string) =>
      getProviderUpdateToastView({
        provider,
        runSeen: runs.has(key) || activeSeen.current.has(key),
        requestFailure: runs.get(key)?.requestFailure ?? null,
        manualReason: getProviderUpdateManualReason({ provider, providers, canManageProviders }),
      });
    for (const [key, notice] of notices.current) {
      const provider = providers.find((candidate) => candidate.instanceId === notice.instanceId);
      if (provider && isProviderUpdateActive(provider)) activeSeen.current.add(key);
      const view = provider ? viewFor(provider, key) : null;
      if (!provider || !view) {
        toastManager.close(notice.id);
        notices.current.delete(key);
        continue;
      }
      toastManager.update(
        notice.id,
        toastOptions(provider, view, () => void runUpdate(key)),
      );
      // A timed toast dismisses itself; updating it again would restart its timer.
      if (view.timeout > 0) notices.current.delete(key);
    }
    for (const provider of collectProviderUpdateCandidates(providers)) {
      const advisory = provider.versionAdvisory;
      const key = `${provider.driver}:${advisory.latestVersion}`;
      if (shown.current.has(key) || isProviderUpdateActive(provider)) continue;
      const view = viewFor(provider, key);
      if (!view || advisory.updateCommand === null) continue;
      shown.current.add(key);
      const id = toastManager.add(toastOptions(provider, view, () => void runUpdate(key)));
      notices.current.set(key, { id, instanceId: provider.instanceId });
    }
  }, [providers, canManageProviders, runs, runUpdate]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes this coordinator's external notices when its authenticated shell unmounts
  useEffect(() => {
    const owned = notices.current;
    return () => {
      for (const notice of owned.values()) toastManager.close(notice.id);
    };
  }, []);
  return null;
}

function toastOptions(
  provider: ServerProvider,
  view: ProviderUpdateToastView,
  onUpdate: () => void,
) {
  const name = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const command = view.command;
  return {
    type: view.type,
    title: view.title,
    description: view.description,
    timeout: view.timeout,
    actionProps:
      view.action?.kind === "update"
        ? {
            children: view.action.label,
            disabled: view.action.disabled,
            onClick: onUpdate,
          }
        : view.action?.kind === "copy" && command !== null
          ? {
              children: "Copy update command",
              disabled: false,
              onClick: () => {
                void writeTextToClipboard(command, "update command");
              },
            }
          : undefined,
    data: {
      variant: "notification" as const,
      leadingIcon: (
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={name}
          className="size-4.5"
        />
      ),
      body: command === null ? null : <CommandBlock command={command} compact />,
    },
  };
}
