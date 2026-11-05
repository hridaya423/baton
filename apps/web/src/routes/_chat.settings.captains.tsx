import { createFileRoute } from "@tanstack/react-router";

import { CaptainsSettings } from "../components/settings/CaptainsSettings";

export const Route = createFileRoute("/_chat/settings/captains")({
  component: CaptainsSettings,
});
