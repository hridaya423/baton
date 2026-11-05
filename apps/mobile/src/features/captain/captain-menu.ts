import type { MenuAction } from "@react-native-menu/menu";
import {
  captainMenuItems,
  type CaptainMenuActionId,
  type CaptainMenuState,
} from "@t3tools/client-runtime/state/captainPresentation";

export interface CaptainMenuPermissions {
  readonly make: boolean;
  readonly release: boolean;
  readonly update: boolean;
}

const IMAGES: Record<CaptainMenuActionId, string> = {
  "make-captain": "person.2",
  "open-crew-board": "person.2",
  "pause-captain": "pause",
  "resume-captain": "play",
  "release-captain": "person.2.slash",
};

/** The captain items of the thread title menu, left out where the user may not do them. */
export function buildCaptainMenuActions(
  state: CaptainMenuState,
  permissions: CaptainMenuPermissions,
): MenuAction[] {
  return captainMenuItems(state)
    .filter((item) => {
      switch (item.id) {
        case "make-captain":
          return permissions.make;
        case "release-captain":
          return permissions.release;
        case "pause-captain":
        case "resume-captain":
          return permissions.update;
        case "open-crew-board":
          return true;
      }
    })
    .map((item) => ({
      id: item.id,
      title: item.label,
      image: IMAGES[item.id],
      ...(item.id === "release-captain" ? { attributes: { destructive: true } } : {}),
    }));
}

export function isCaptainMenuAction(event: string): event is CaptainMenuActionId {
  return (
    event === "make-captain" ||
    event === "release-captain" ||
    event === "pause-captain" ||
    event === "resume-captain" ||
    event === "open-crew-board"
  );
}

/** What the native header must notice to redraw the menu. */
export function captainMenuKey(state: CaptainMenuState): string {
  return state.kind === "captain" ? `captain:${state.status}` : state.kind;
}
