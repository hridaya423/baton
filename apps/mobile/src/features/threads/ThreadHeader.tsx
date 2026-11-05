import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { Platform } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { isDuoDevice } from "../../lib/device-type";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useDeviceType, useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { threadTitleMaxWidth, threadTitleMenuVersion } from "./thread-title-menu";
import { ThreadTitleMenu } from "./ThreadTitleMenu";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly thread: EnvironmentThreadShell | null;
  /** False while a client-only creation is preparing, before the server owns the thread. */
  readonly canMutateThread: boolean;
  readonly hasThreadCwd: boolean;
  readonly fileInspectorSupported: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onToggleInspector: () => void;
  readonly onOpenFilesInspector: () => void;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane, composerKeyboardActive, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const metrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const usesDuoHeader = useNativeWorkspaceColumnsSupported() && isDuoDevice(deviceType);
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const inspectorVisible = props.inspectorMode !== null && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  const android = Platform.OS === "android";
  const titleMaxWidth = android
    ? 0
    : threadTitleMaxWidth({
        paneWidth: Math.min(frame.width, panes.contentPaneWidth),
        horizontalInsets: insets.left + insets.right,
        verticalBar: metrics != null && metrics.verticalBarEdge !== "none",
        leadingItems: layout.usesSplitView
          ? [
              { icon: "sidebar.left" },
              ...(props.onReturnToThread ? [{ icon: "chevron.left" }] : []),
              ...(props.draft || usesDuoHeader ? [] : [{ icon: "square.and.pencil" }, {}]),
            ]
          : null,
        trailingItems: [
          ...actions,
          ...menus,
          ...(props.fileInspectorSupported && props.hasThreadCwd ? [{}] : []),
        ].map(() => ({ icon: "ellipsis" })),
        compose: usesDuoHeader,
      });
  const titleContent = props.thread ? (
    <ThreadTitleMenu
      key={scopedThreadKey(props.thread.environmentId, props.thread.id)}
      thread={props.thread}
      canMutate={props.canMutateThread}
      subtitle={props.subtitle}
      maxWidth={titleMaxWidth}
      compact={composerKeyboardActive}
    />
  ) : undefined;

  return (
    <>
      {titleContent && !android ? (
        <NativeStackScreenOptions
          options={{ headerTitle: () => titleContent }}
          optionsVersion={[
            titleMaxWidth,
            props.subtitle,
            threadTitleMenuVersion(props.thread),
            props.canMutateThread,
          ]}
        />
      ) : null}
      <AppBar
        title={props.title}
        titleContent={titleContent}
        subtitle={titleContent && !android ? null : props.subtitle}
        onBackToList={goBack}
        onCompose={props.draft ? undefined : startNewTask}
        backInSplitView={
          props.onReturnToThread
            ? {
                accessibilityLabel: "Return to chat",
                icon: "chevron.left",
                onPress: props.onReturnToThread,
              }
            : undefined
        }
        actions={actions}
        menus={menus}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={inspectorVisible ? "Hide inspector" : "Show inspector"}
              icon="sidebar.right"
              selected={inspectorVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        hideBottomBorder
        compact={composerKeyboardActive}
      />
    </>
  );
}
