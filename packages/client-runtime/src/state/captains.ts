import { WS_METHODS, type Captain, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  captainSidebarIndex,
  EMPTY_CAPTAIN_BOARD,
  reduceCaptainBoard,
  type CaptainBoardState,
  type CaptainCrewEntry,
  type CaptainSidebarIndex,
} from "./captainBoard.ts";
import { createCaptainOrderAtoms } from "./captainOrders.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCaptainEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    ...createCaptainOrderAtoms(runtime),
    /** The environment's captains, their orders and open needs-you items, folded from the stream. */
    board: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:captains:board",
      tag: WS_METHODS.captainsBoardSubscribe,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_CAPTAIN_BOARD, reduceCaptainBoard)),
    }),
    makeCaptain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:create",
      tag: WS_METHODS.captainsCreate,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    releaseCaptain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:release",
      tag: WS_METHODS.captainsRelease,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.captainId}`,
      },
    }),
    resolveEscalation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:resolve-escalation",
      tag: WS_METHODS.captainsEscalationsResolve,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.escalationId}`,
      },
    }),
  };
}

export type CaptainEnvironmentAtoms = ReturnType<typeof createCaptainEnvironmentAtoms>;

const NO_CREW: ReadonlyArray<CaptainCrewEntry> = [];

/** A thread's atom key. Environment and thread ids contain no newline. */
export const captainThreadAtomKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\n${threadId}`;

/**
 * What every client reads off the board streams: one board per connected environment whose
 * server serves captains, and the per-thread slices of it, so a row rerenders only for its own.
 */
export function createCaptainViewAtoms(input: {
  readonly board: CaptainEnvironmentAtoms["board"];
  readonly serverConfigsAtom: Atom.Atom<
    ReadonlyMap<
      EnvironmentId,
      { readonly environment: { readonly capabilities: { readonly captains?: boolean } } }
    >
  >;
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
}) {
  const boardsAtom = Atom.make((get) => {
    const configs = get(input.serverConfigsAtom);
    const boards = new Map<EnvironmentId, CaptainBoardState>();
    for (const environmentId of get(input.connectedEnvironmentIdsAtom)) {
      if (configs.get(environmentId)?.environment.capabilities.captains !== true) continue;
      boards.set(
        environmentId,
        AsyncResult.getOrElse(
          get(input.board({ environmentId, input: {} })),
          () => EMPTY_CAPTAIN_BOARD,
        ),
      );
    }
    return boards;
  }).pipe(Atom.withLabel("captains:boards"));

  const sidebarIndexesAtom = Atom.make((get) => {
    const indexes = new Map<EnvironmentId, CaptainSidebarIndex>();
    for (const [environmentId, board] of get(boardsAtom)) {
      indexes.set(environmentId, captainSidebarIndex(board));
    }
    return indexes;
  }).pipe(Atom.withLabel("captains:sidebar-indexes"));

  const emptyBoardAtom = Atom.make(EMPTY_CAPTAIN_BOARD).pipe(
    Atom.withLabel("captains:board:empty"),
  );

  const boardOfAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(boardsAtom).get(environmentId) ?? EMPTY_CAPTAIN_BOARD).pipe(
      Atom.withLabel(`captains:board:${environmentId}`),
    ),
  );

  const lookupThread = (indexes: ReadonlyMap<EnvironmentId, CaptainSidebarIndex>, key: string) => {
    const [environmentId, threadId] = key.split("\n") as [EnvironmentId, ThreadId];
    return { threadId, index: indexes.get(environmentId) };
  };

  const captainOfThreadAtom = Atom.family((key: string) =>
    Atom.make((get): Captain | null => {
      const { threadId, index } = lookupThread(get(sidebarIndexesAtom), key);
      return index?.captainByThreadId.get(threadId) ?? null;
    }).pipe(Atom.withLabel(`captains:of-thread:${key}`)),
  );

  const needsYouOfThreadAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const { threadId, index } = lookupThread(get(sidebarIndexesAtom), key);
      return index?.needsYouByCaptainThreadId.get(threadId) ?? 0;
    }).pipe(Atom.withLabel(`captains:needs-you:${key}`)),
  );

  const crewOfThreadAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const { threadId, index } = lookupThread(get(sidebarIndexesAtom), key);
      return index?.crewByCaptainThreadId.get(threadId) ?? NO_CREW;
    }).pipe(Atom.withLabel(`captains:crew:${key}`)),
  );

  return {
    boardsAtom,
    sidebarIndexesAtom,
    emptyBoardAtom,
    boardOfAtom,
    captainOfThreadAtom,
    needsYouOfThreadAtom,
    crewOfThreadAtom,
  };
}
