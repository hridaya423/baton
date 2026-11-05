import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  isSecretReference,
  type ProjectId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { mediaSpendToday } from "../../state/media";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsNote,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

type KeyField = "openaiApiKey" | "geminiApiKey" | "falApiKey";

const KEY_ROWS: ReadonlyArray<{
  readonly field: KeyField;
  readonly title: string;
  readonly description: string;
}> = [
  {
    field: "openaiApiKey",
    title: "OpenAI key",
    description: "Makes and edits images with gpt-image models. Falls back to OPENAI_API_KEY.",
  },
  {
    field: "geminiApiKey",
    title: "Gemini key",
    description: "Makes and edits images with Gemini. Falls back to GEMINI_API_KEY.",
  },
  {
    field: "falApiKey",
    title: "fal.ai key",
    description: "Makes video with Seedance, Kling and Veo. Falls back to FAL_KEY.",
  },
];

function KeyRow(props: {
  readonly environmentId: EnvironmentId;
  readonly saved: SettingsSecretValue;
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onSave: (value: SettingsSecretValue) => void;
}) {
  const sources = useSecretSources(props.environmentId);
  const [revision, setRevision] = useState(0);
  const configured = props.saved !== "";
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <div className="flex w-72 max-w-full items-center gap-2">
          <SecretSourceInput
            key={revision}
            aria-label={props.title}
            className="min-w-0 flex-1"
            configured={configured && typeof props.saved === "string"}
            value={isSecretReference(props.saved) ? props.saved : ""}
            sources={sources}
            disabled={props.disabled}
            onSecretChange={(secret) => props.onSave(secret ?? "")}
            onCommit={(next) => {
              if (next !== "") props.onSave(next);
            }}
          />
          {configured ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              aria-label={`Clear ${props.title}`}
              disabled={props.disabled}
              onClick={() => {
                props.onSave("");
                setRevision((current) => current + 1);
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function SpendRow(props: { readonly environmentId: EnvironmentId }) {
  const groups = useSettingsProjectGroups();
  const projects = groups.flatMap((group) =>
    group.memberProjects
      .filter((member) => member.environmentId === props.environmentId)
      .map((member) => ({ id: member.id as ProjectId, name: group.displayName })),
  );
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const project = projects.find((entry) => entry.id === picked) ?? projects[0];
  const spend = useEnvironmentQuery(
    project === undefined
      ? null
      : mediaSpendToday({ environmentId: props.environmentId, input: { projectId: project.id } }),
  );
  if (project === undefined) return null;
  return (
    <SettingsRow
      title="Spent today"
      description="Image and video calls for the project since midnight UTC."
      control={
        <div className="flex items-center gap-3">
          <Text variant="body" role="status">
            {spend.data === null
              ? "…"
              : `$${spend.data.usd.toFixed(2)} of $${spend.data.capUsd.toFixed(2)}`}
          </Text>
          <Select
            value={project.id}
            onValueChange={(value) => {
              if (value !== null) setPicked(value as ProjectId);
            }}
          >
            <SelectTrigger size="sm" aria-label="Project">
              <SelectValue>{project.name}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {projects.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

export function MediaSettings() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;
  const media = environment?.serverConfig?.settings.media;
  const supported = environment?.serverConfig?.environment.capabilities.media === true;
  const update = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [capRevision, setCapRevision] = useState(0);

  if (environmentId === null || media === undefined || !supported) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Media">
          <SettingsNote>
            {environmentId === null
              ? "Connect to an environment to set its media keys."
              : "This environment's server has no media tools yet. Update it to use them."}
          </SettingsNote>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Media">
        {KEY_ROWS.map((row) => (
          <KeyRow
            key={row.field}
            environmentId={environmentId}
            saved={media[row.field]}
            title={row.title}
            description={row.description}
            disabled={!canWrite}
            onSave={(value) => void update({ media: { [row.field]: value } })}
          />
        ))}
        <SettingsRow
          title="Daily spend cap"
          description="USD per project per day. A call that would pass it is refused before it is sent."
          control={
            <NumberField
              key={`${media.dailySpendCapUsd}:${capRevision}`}
              defaultValue={media.dailySpendCapUsd}
              min={0}
              size="sm"
              className="w-28"
              disabled={!canWrite}
              onValueCommitted={(next) => {
                if (next === null || next === media.dailySpendCapUsd) {
                  setCapRevision((current) => current + 1);
                  return;
                }
                void update({ media: { dailySpendCapUsd: next } });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Daily spend cap" />
              </NumberFieldGroup>
            </NumberField>
          }
        />
        <SpendRow environmentId={environmentId} />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
