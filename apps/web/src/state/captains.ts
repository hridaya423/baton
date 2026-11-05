import { useAtomValue } from "@effect/atom-react";
import {
  type CaptainBoardState,
  type CaptainCrewEntry,
  type CaptainSidebarIndex,
  captainSidebarIndex,
  EMPTY_CAPTAIN_BOARD,
} from "@t3tools/client-runtime/state/captainBoard";
import { createCaptainEnvironmentAtoms } from "@t3tools/client-runtime/state/captains";
import type { Captain, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations, environmentSummaries } from "./presentation";

export const captainEnvironment = createCaptainEnvironmentAtoms(connectionAtomRuntime);

/** Every connected environment whose server serves captains, each on one shared board stream. */
const captainBoardsAtom = Atom.make((get) => {
  const configs = get(environmentPresentations.serverConfigsAtom);
  const boards = new Map<EnvironmentId, CaptainBoardState>();
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    if (configs.get(environmentId)?.environment.capabilities.captains !== true) continue;
    boards.set(
      environmentId,
      AsyncResult.getOrElse(
        get(captainEnvironment.board({ environmentId, input: {} })),
        () => EMPTY_CAPTAIN_BOARD,
      ),
    );
  }
  return boards;
}).pipe(Atom.withLabel("captains:boards"));

const captainSidebarIndexesAtom = Atom.make((get) => {
  const indexes = new Map<EnvironmentId, CaptainSidebarIndex>();
  for (const [environmentId, board] of get(captainBoardsAtom)) {
    indexes.set(environmentId, captainSidebarIndex(board));
  }
  return indexes;
}).pipe(Atom.withLabel("captains:sidebar-indexes"));

export function useCaptainBoards(): ReadonlyMap<EnvironmentId, CaptainBoardState> {
  return useAtomValue(captainBoardsAtom);
}

export function useCaptainSidebarIndexes(): ReadonlyMap<EnvironmentId, CaptainSidebarIndex> {
  return useAtomValue(captainSidebarIndexesAtom);
}

const EMPTY_BOARD_ATOM = Atom.make(EMPTY_CAPTAIN_BOARD).pipe(
  Atom.withLabel("captains:board:empty"),
);

const boardOfAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(captainBoardsAtom).get(environmentId) ?? EMPTY_CAPTAIN_BOARD).pipe(
    Atom.withLabel(`captains:board:${environmentId}`),
  ),
);

/** One environment's board; a rerender follows only when that board changes. */
export function useCaptainBoard(environmentId: EnvironmentId | null): CaptainBoardState {
  return useAtomValue(environmentId === null ? EMPTY_BOARD_ATOM : boardOfAtom(environmentId));
}

/** The index now, for handlers that should not rerender on every board change. */
export function readCaptainSidebarIndex(
  environmentId: EnvironmentId,
): CaptainSidebarIndex | undefined {
  return appAtomRegistry.get(captainSidebarIndexesAtom).get(environmentId);
}

const NO_CREW: ReadonlyArray<CaptainCrewEntry> = [];

const threadKeyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\n${threadId}`;

const lookupThread = (indexes: ReadonlyMap<EnvironmentId, CaptainSidebarIndex>, key: string) => {
  const [environmentId, threadId] = key.split("\n") as [EnvironmentId, ThreadId];
  return { threadId, index: indexes.get(environmentId) };
};

const captainOfThreadAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { threadId, index } = lookupThread(get(captainSidebarIndexesAtom), key);
    return index?.captainByThreadId.get(threadId) ?? null;
  }).pipe(Atom.withLabel(`captains:of-thread:${key}`)),
);

const needsYouOfThreadAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { threadId, index } = lookupThread(get(captainSidebarIndexesAtom), key);
    return index?.needsYouByCaptainThreadId.get(threadId) ?? 0;
  }).pipe(Atom.withLabel(`captains:needs-you:${key}`)),
);

const crewOfThreadAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { threadId, index } = lookupThread(get(captainSidebarIndexesAtom), key);
    return index?.crewByCaptainThreadId.get(threadId) ?? NO_CREW;
  }).pipe(Atom.withLabel(`captains:crew:${key}`)),
);

/** The captain a thread is, or null. A row rerenders only when its own captain changes. */
export function useCaptainOfThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Captain | null {
  return useAtomValue(captainOfThreadAtom(threadKeyOf(environmentId, threadId)));
}

export function useCaptainNeedsYou(environmentId: EnvironmentId, threadId: ThreadId): number {
  return useAtomValue(needsYouOfThreadAtom(threadKeyOf(environmentId, threadId)));
}

export function useCaptainCrew(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<CaptainCrewEntry> {
  return useAtomValue(crewOfThreadAtom(threadKeyOf(environmentId, threadId)));
}
