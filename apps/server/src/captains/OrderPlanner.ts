import type { CaptainOrder, CaptainOrderId } from "@t3tools/contracts";

type Planned = Pick<CaptainOrder, "id" | "kind" | "touches" | "dependsOn" | "state">;

const globBase = (glob: string) => {
  const trimmed = glob.trim().replace(/^\.\//, "");
  const wildcard = trimmed.search(/[*?[{]/);
  return wildcard === -1 ? trimmed : trimmed.slice(0, wildcard);
};

/** Conservative: false only when no path can match both globs. */
export const globsOverlap = (left: string, right: string): boolean => {
  const a = globBase(left);
  const b = globBase(right);
  return a.startsWith(b) || b.startsWith(a);
};

/** Reports touch nothing. An empty `touches` on a change order means unknown, so it overlaps. */
export const ordersOverlap = (
  left: Pick<CaptainOrder, "kind" | "touches">,
  right: Pick<CaptainOrder, "kind" | "touches">,
): boolean => {
  if (left.kind === "report" || right.kind === "report") return false;
  if (left.touches.length === 0 || right.touches.length === 0) return true;
  return left.touches.some((a) => right.touches.some((b) => globsOverlap(a, b)));
};

export const selectAdmissions = (input: {
  readonly crewCap: number;
  readonly orders: ReadonlyArray<Planned>;
}): ReadonlyArray<CaptainOrderId> => {
  const running = input.orders.filter((order) => order.state === "running");
  const done = new Set(input.orders.filter((order) => order.state === "done").map((o) => o.id));
  const admitted: Array<CaptainOrderId> = [];
  for (const order of input.orders) {
    if (running.length >= input.crewCap) break;
    if (order.state !== "queued") continue;
    if (!order.dependsOn.every((id) => done.has(id))) continue;
    if (running.some((active) => ordersOverlap(order, active))) continue;
    running.push(order);
    admitted.push(order.id);
  }
  return admitted;
};

export const slug = (text: string, max: number): string => {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return cleaned.length === 0 ? "order" : cleaned;
};
