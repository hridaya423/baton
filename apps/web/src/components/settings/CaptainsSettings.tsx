import type {
  Captain,
  CaptainCharter,
  CaptainCharterPatch,
  CaptainOrderDelivery,
  EnvironmentId,
  RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { AnchorIcon } from "lucide-react";
import { useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { captainEnvironment, useCaptainBoards } from "../../state/captains";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { DELIVERY_LABELS } from "../captain/captainLabels";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Text } from "../ui/text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsNote,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SettingsModelPicker } from "./SettingsModelPicker";
import { useScopedSettings } from "./useScopedSettings";

const DELIVERIES: ReadonlyArray<CaptainOrderDelivery> = ["none", "branch", "pr", "merge"];

type CharterNumberKey = "crewCap" | "retryLimit" | "stallMinutes" | "verifyTimeoutMinutes";

function CharterNumberRow(props: {
  readonly title: string;
  readonly description: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly onCommit: (value: number) => Promise<boolean>;
}) {
  const { title, description, value, min, max, onCommit } = props;
  const [revision, setRevision] = useState(0);
  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <NumberField
          key={`${value}:${revision}`}
          defaultValue={value}
          min={min}
          {...(max === undefined ? {} : { max })}
          size="sm"
          className="w-28"
          onValueCommitted={async (next) => {
            if (next === null || next === value) {
              setRevision((current) => current + 1);
              return;
            }
            if (!(await onCommit(next))) setRevision((current) => current + 1);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldInput aria-label={title} />
          </NumberFieldGroup>
        </NumberField>
      }
    />
  );
}

function ReviewModelRow(props: {
  readonly environmentId: EnvironmentId;
  readonly charter: CaptainCharter;
  readonly onChange: (patch: CaptainCharterPatch) => Promise<boolean>;
}) {
  const { environmentId, charter, onChange } = props;
  const settings = useScopedSettings();
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const fallback = instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const selection = charter.reviewModel;
  const activeInstanceId = selection?.instanceId ?? fallback?.instanceId;
  const model = selection?.model ?? fallback?.models[0]?.slug;
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId ?? null,
    model ?? null,
  );

  return (
    <SettingsRow
      title="Review model"
      description="Reads each finished change and reports findings. A different provider than the crew's catches more."
      resetAction={
        selection ? (
          <SettingResetButton
            label="review model"
            tooltip="Use the crew's model"
            onClick={() => void onChange({ reviewModel: null })}
          />
        ) : undefined
      }
      control={
        activeInstanceId === undefined || model === undefined ? (
          <span className="text-body text-muted-foreground">No providers available.</span>
        ) : (
          <SettingsModelPicker
            environmentId={environmentId}
            activeInstanceId={activeInstanceId}
            model={model}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            {...(selection ? {} : { triggerLabel: "Same as crew" })}
            onInstanceModelChange={(instanceId, nextModel) =>
              void onChange({
                ...charter,
                reviewModel: createModelSelection(instanceId, nextModel),
              })
            }
            traits={
              selection && activeEntry
                ? {
                    provider: activeEntry.driverKind,
                    models: activeEntry.models,
                    modelOptions: selection.options,
                    planModeEnabled: settings.planModeEnabled,
                    onModelOptionsChange: (options) =>
                      void onChange({
                        ...charter,
                        reviewModel: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          options,
                        ),
                      }),
                  }
                : null
            }
          />
        )
      }
    />
  );
}

function CaptainCharterSection(props: {
  readonly environmentId: EnvironmentId;
  readonly captain: Captain;
  readonly environmentLabel: string | null;
}) {
  const { environmentId, captain, environmentLabel } = props;
  const { charter } = captain;
  const updateCaptain = useAtomCommand(captainEnvironment.updateCaptain);
  const paused = captain.status === "paused";

  const saveCharter = async (next: CaptainCharterPatch) => {
    const result = await updateCaptain({
      environmentId,
      input: { captainId: captain.id, charter: next },
    });
    return result._tag === "Success";
  };
  const saveNumber = (key: CharterNumberKey) => (value: number) =>
    saveCharter({ ...charter, [key]: value });

  return (
    <SettingsSection
      title={captain.name}
      titleAction={
        environmentLabel === null ? null : (
          <Text variant="meta" tone="muted">
            {environmentLabel}
          </Text>
        )
      }
      icon={<AnchorIcon className="size-3.5" aria-hidden />}
      headerAction={
        <Button
          size="xs"
          variant="secondary"
          onClick={() =>
            void updateCaptain({
              environmentId,
              input: { captainId: captain.id, status: paused ? "active" : "paused" },
            })
          }
        >
          {paused ? "Resume" : "Pause"}
        </Button>
      }
    >
      <CharterNumberRow
        title="Crew size"
        description="How many crew threads work at once. The rest wait in the queue."
        value={charter.crewCap}
        min={1}
        onCommit={saveNumber("crewCap")}
      />
      <SettingsRow
        title="Default delivery"
        description="What happens to finished changes unless an order says otherwise."
        control={
          <Select
            value={charter.defaultDelivery}
            onValueChange={(value) => {
              if (value !== null) {
                void saveCharter({ ...charter, defaultDelivery: value as CaptainOrderDelivery });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Default delivery">
              <SelectValue>{DELIVERY_LABELS[charter.defaultDelivery]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {DELIVERIES.map((delivery) => (
                <SelectItem key={delivery} value={delivery}>
                  {DELIVERY_LABELS[delivery]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Crew access"
        description={runtimeModeConfig[charter.crewRuntimeMode].description}
        control={
          <Select
            value={charter.crewRuntimeMode}
            onValueChange={(value) => {
              if (value !== null) {
                void saveCharter({ ...charter, crewRuntimeMode: value as RuntimeMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Crew access">
              <SelectValue>{runtimeModeConfig[charter.crewRuntimeMode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {runtimeModeOptions.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {runtimeModeConfig[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <CharterNumberRow
        title="Retry limit"
        description="Times a crew thread may retry a failed check before it asks you."
        value={charter.retryLimit}
        min={0}
        onCommit={saveNumber("retryLimit")}
      />
      <CharterNumberRow
        title="Stall minutes"
        description="Minutes without activity before the captain treats a crew thread as stuck."
        value={charter.stallMinutes}
        min={1}
        onCommit={saveNumber("stallMinutes")}
      />
      <CharterNumberRow
        title="Check timeout"
        description="Minutes the done check may run before it counts as failed."
        value={charter.verifyTimeoutMinutes ?? 10}
        min={1}
        max={120}
        onCommit={saveNumber("verifyTimeoutMinutes")}
      />
      <ReviewModelRow environmentId={environmentId} charter={charter} onChange={saveCharter} />
    </SettingsSection>
  );
}

export function CaptainsSettings() {
  const boards = useCaptainBoards();
  const { environments } = useEnvironments();
  const sections = [...boards].flatMap(([environmentId, board]) =>
    [...board.captains.values()]
      .filter((captain) => captain.status !== "released")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((captain) => ({ environmentId, captain })),
  );

  return (
    <SettingsPageContainer>
      {sections.length === 0 ? (
        <SettingsSection title="Captains">
          <SettingsNote>
            No captains yet. Open a thread's menu and choose Make captain.
          </SettingsNote>
        </SettingsSection>
      ) : (
        sections.map(({ environmentId, captain }) => (
          <CaptainCharterSection
            key={captain.id}
            environmentId={environmentId}
            captain={captain}
            environmentLabel={
              boards.size > 1
                ? (environments.find((entry) => entry.environmentId === environmentId)?.label ??
                  null)
                : null
            }
          />
        ))
      )}
    </SettingsPageContainer>
  );
}
