import { useAtomValue } from "@effect/atom-react";
import {
  type CaptainBoardState,
  type CaptainCrewEntry,
  type CaptainSidebarIndex,
} from "@t3tools/client-runtime/state/captainBoard";
import {
  captainThreadAtomKey,
  createCaptainEnvironmentAtoms,
  createCaptainViewAtoms,
} from "@t3tools/client-runtime/state/captains";
import type { Captain, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations, environmentSummaries } from "./presentation";

export const captainEnvironment = createCaptainEnvironmentAtoms(connectionAtomRuntime);

const view = createCaptainViewAtoms({
  board: captainEnvironment.board,
  serverConfigsAtom: environmentPresentations.serverConfigsAtom,
  connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
});

export function useCaptainBoards(): ReadonlyMap<EnvironmentId, CaptainBoardState> {
  return useAtomValue(view.boardsAtom);
}

export function useCaptainSidebarIndexes(): ReadonlyMap<EnvironmentId, CaptainSidebarIndex> {
  return useAtomValue(view.sidebarIndexesAtom);
}

/** One environment's board; a rerender follows only when that board changes. */
export function useCaptainBoard(environmentId: EnvironmentId | null): CaptainBoardState {
  return useAtomValue(
    environmentId === null ? view.emptyBoardAtom : view.boardOfAtom(environmentId),
  );
}

/** The index now, for handlers that should not rerender on every board change. */
export function readCaptainSidebarIndex(
  environmentId: EnvironmentId,
): CaptainSidebarIndex | undefined {
  return appAtomRegistry.get(view.sidebarIndexesAtom).get(environmentId);
}

/** The captain a thread is, or null. A row rerenders only when its own captain changes. */
export function useCaptainOfThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Captain | null {
  return useAtomValue(view.captainOfThreadAtom(captainThreadAtomKey(environmentId, threadId)));
}

export function useCaptainNeedsYou(environmentId: EnvironmentId, threadId: ThreadId): number {
  return useAtomValue(view.needsYouOfThreadAtom(captainThreadAtomKey(environmentId, threadId)));
}

export function useCaptainCrew(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<CaptainCrewEntry> {
  return useAtomValue(view.crewOfThreadAtom(captainThreadAtomKey(environmentId, threadId)));
}
