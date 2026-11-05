import { createFileRoute } from "@tanstack/react-router";

import { MediaSettings } from "../components/settings/MediaSettings";

export const Route = createFileRoute("/_chat/settings/media")({
  component: MediaSettings,
});
