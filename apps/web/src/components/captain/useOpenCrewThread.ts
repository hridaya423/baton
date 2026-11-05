import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { useLayoutStore } from "../../layout/layoutStore";
import { buildThreadRouteParams } from "../../threadRoutes";

export function useOpenCrewThread() {
  const router = useRouter();
  return (threadRef: ScopedThreadRef) => {
    useLayoutStore.getState().focusChat({ kind: "server", threadRef });
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };
}
