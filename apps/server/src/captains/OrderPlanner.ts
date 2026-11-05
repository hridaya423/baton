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

/** Work not yet accepted: its files stay claimed while the crew runs, the check runs or a reviewer reads. */
const HOLDS_FILES: ReadonlySet<Planned["state"]> = new Set([
  "running",
  "verifying",
  "verify_failed",
  "reviewing",
]);

export const SATISFIES_DEPENDENCY: ReadonlySet<Planned["state"]> = new Set([
  "done",
  "accepted",
  "landing",
  "landed",
  "land_failed",
]);

/** Only a crew at work takes a slot of the crew cap. */
export const selectAdmissions = (input: {
  readonly crewCap: number;
  readonly orders: ReadonlyArray<Planned>;
}): ReadonlyArray<CaptainOrderId> => {
  const holding = input.orders.filter((order) => HOLDS_FILES.has(order.state));
  let crewAtWork = input.orders.filter((order) => order.state === "running").length;
  const satisfied = new Set(
    input.orders.filter((order) => SATISFIES_DEPENDENCY.has(order.state)).map((o) => o.id),
  );
  const admitted: Array<CaptainOrderId> = [];
  for (const order of input.orders) {
    if (crewAtWork >= input.crewCap) break;
    if (order.state !== "queued") continue;
    if (!order.dependsOn.every((id) => satisfied.has(id))) continue;
    if (holding.some((active) => ordersOverlap(order, active))) continue;
    holding.push(order);
    crewAtWork++;
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
