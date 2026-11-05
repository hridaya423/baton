import {
  CaptainEscalationId,
  CaptainId,
  EnvironmentId,
  type CaptainEscalation,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const rpc = vi.hoisted(() => ({
  calls: [] as unknown[],
}));

vi.mock(import("../../state/captains"), () => ({
  captainEnvironment: { resolveEscalation: { permissionAtom: () => Atom.make(true) } } as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async (value: unknown) => {
    rpc.calls.push(value);
    return AsyncResult.success(undefined);
  }) as never,
}));

import { EscalationCard } from "./EscalationCard";

const environmentId = EnvironmentId.make("local");

function escalation(overrides: Partial<CaptainEscalation>): CaptainEscalation {
  return {
    id: CaptainEscalationId.make("escalation-1"),
    captainId: CaptainId.make("captain-1"),
    orderId: null,
    kind: "decision",
    summary: "Which README tone?",
    detail: "",
    options: ["Playful", "Plain"],
    status: "open",
    resolution: null,
    requestId: null,
    createdAt: "2026-11-05T00:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

function setup() {
  rpc.calls = [];
}

it.each([
  ["decision", { options: ["Playful", "Plain"] }, "Plain", "Plain"],
  ["approval", { kind: "approval", options: [] }, "Deny", "Deny"],
  ["approval", { kind: "approval", options: [] }, "Approve", "Approve"],
] as const)(
  "resolves a %s card through the RPC with the clicked answer",
  async (_kind, overrides, button, resolution) => {
    setup();
    await using _screen = await render(
      <EscalationCard environmentId={environmentId} escalation={escalation(overrides)} />,
    );

    await page.getByRole("button", { name: button, exact: true }).click();

    await vi.waitFor(() =>
      expect(rpc.calls).toEqual([
        { environmentId, input: { escalationId: "escalation-1", resolution } },
      ]),
    );
  },
);

it("sends a free-text answer", async () => {
  setup();
  await using _screen = await render(
    <EscalationCard environmentId={environmentId} escalation={escalation({})} />,
  );

  await page.getByRole("textbox", { name: "Your answer" }).fill("Dry, with one joke");
  await page.getByRole("button", { name: "Send" }).click();

  await vi.waitFor(() =>
    expect(rpc.calls).toEqual([
      { environmentId, input: { escalationId: "escalation-1", resolution: "Dry, with one joke" } },
    ]),
  );
});
