import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  isSecretReference,
  type ProjectId,
  type ServerSettingsPatch,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { mediaSpendToday } from "../../state/media";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

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

type SaveSettings = (patch: ServerSettingsPatch) => Promise<void>;

function KeyRow(props: {
  readonly saved: SettingsSecretValue;
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onSave: (value: SettingsSecretValue) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const configured = props.saved !== "";
  const fromSecretSource = isSecretReference(props.saved);
  const editing = !configured || replacing;
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="body">{props.title}</Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {props.description}
      </Text>
      {editing ? (
        <View className="flex-row items-center gap-2">
          <AppTextInput
            accessibilityLabel={props.title}
            className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
            placeholder="Paste a key"
            value={draft}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
            returnKeyType="done"
            onChangeText={setDraft}
          />
          <Button
            label="Save"
            tone="secondary"
            size="compact"
            disabled={props.disabled || draft.trim().length === 0}
            onPress={() => {
              props.onSave(draft.trim());
              setDraft("");
              setReplacing(false);
            }}
          />
        </View>
      ) : (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text textRole="footnote" className="min-w-0 flex-1 font-t3-medium">
            {fromSecretSource ? "Set from a secret source" : "Key saved"}
          </Text>
          {fromSecretSource ? null : (
            <Button
              label="Replace"
              tone="text"
              size="compact"
              disabled={props.disabled}
              onPress={() => setReplacing(true)}
            />
          )}
          <Button
            label="Clear"
            tone="danger"
            size="compact"
            disabled={props.disabled}
            onPress={() => props.onSave("")}
          />
        </View>
      )}
    </View>
  );
}

function CapRow(props: {
  readonly saved: number;
  readonly disabled: boolean;
  readonly onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? null : Number(draft);
  const valid = parsed !== null && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000;
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="body">Daily spend cap</Text>
      <Text textRole="footnote" className="text-foreground-muted">
        USD per project per day. A call that would pass it is refused before it is sent.
      </Text>
      <View className="flex-row items-center gap-2">
        <AppTextInput
          accessibilityLabel="Daily spend cap in US dollars"
          className="min-h-11 w-28 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          keyboardType="decimal-pad"
          value={draft ?? String(props.saved)}
          editable={!props.disabled}
          onChangeText={setDraft}
        />
        {draft !== null && draft !== String(props.saved) ? (
          <Button
            label="Save"
            tone="secondary"
            size="compact"
            disabled={props.disabled || !valid}
            onPress={() => {
              if (valid) props.onSave(parsed);
              setDraft(null);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function SpendRow(props: { readonly environmentId: EnvironmentId }) {
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const project = projects.find((entry) => entry.id === picked) ?? projects[0];
  const spend = useEnvironmentQuery(
    project === undefined
      ? null
      : mediaSpendToday({ environmentId: props.environmentId, input: { projectId: project.id } }),
  );
  if (project === undefined) return null;
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="body">Spent today</Text>
      <Text textRole="footnote" className="text-foreground-muted">
        Image and video calls for the project since midnight UTC.
      </Text>
      <View className="flex-row flex-wrap items-center gap-3">
        <Text textRole="body" className="font-t3-medium tabular-nums" accessibilityRole="summary">
          {spend.data === null
            ? "…"
            : `$${spend.data.usd.toFixed(2)} of $${spend.data.capUsd.toFixed(2)}`}
        </Text>
        {projects.length > 1 ? (
          <Menu
            title="Project"
            actions={projects.map((entry) => ({ id: entry.id, title: entry.title }))}
            onPressAction={({ nativeEvent }) => setPicked(nativeEvent.event as ProjectId)}
          >
            <Button
              label={project.title}
              tone="secondary"
              size="compact"
              onPress={() => undefined}
            />
          </Menu>
        ) : (
          <Text textRole="footnote" className="text-foreground-muted">
            {project.title}
          </Text>
        )}
      </View>
    </View>
  );
}

function MediaSettingsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly media: {
    readonly openaiApiKey: SettingsSecretValue;
    readonly geminiApiKey: SettingsSecretValue;
    readonly falApiKey: SettingsSecretValue;
    readonly dailySpendCapUsd: number;
  };
  readonly note: string | null;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "media settings update",
    reportFailure: false,
  });
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const [saving, setSaving] = useState(false);
  const save: SaveSettings = async (patch) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId: props.environmentId,
      input: { patch },
    });
    setSaving(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    Dialog.alert(
      "Could not save settings",
      failure instanceof Error ? failure.message : "Try again.",
    );
  };
  const disabled = !canWrite || saving;
  return (
    <>
      <SettingsSection title="API keys" footer={props.note ?? undefined}>
        {KEY_ROWS.map((row) => (
          <KeyRow
            key={row.field}
            saved={props.media[row.field]}
            title={row.title}
            description={row.description}
            disabled={disabled}
            onSave={(value) => void save({ media: { [row.field]: value } })}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Spend">
        <CapRow
          saved={props.media.dailySpendCapUsd}
          disabled={disabled}
          onSave={(value) => void save({ media: { dailySpendCapUsd: value } })}
        />
        <SpendRow environmentId={props.environmentId} />
      </SettingsSection>
    </>
  );
}

export function SettingsMediaRouteScreen() {
  const insets = useSafeAreaInsets();
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const supported = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.media === true,
  );
  const target = supported[0] ?? null;
  const message =
    selectedTargets.length === 0
      ? "Connect to an environment to set its media keys."
      : target === null
        ? "This environment's server has no media tools yet. Update it to use them."
        : null;
  const note =
    supported.length > 1
      ? `Showing ${target?.label}. Choose one environment in the filter to edit another.`
      : null;

  return (
    <SettingsScreen title="Media" menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {target === null || message !== null ? (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {message}
          </Text>
        ) : (
          <MediaSettingsBody
            environmentId={target.environmentId}
            media={target.serverConfig.settings.media}
            note={note}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
