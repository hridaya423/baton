import type { CaptainOrderState } from "@t3tools/contracts";

/**
 * What an order is made of on the board: planned work is a dashed outline, work under way or
 * finished is solid, and dropped work is a faint wireframe.
 */
export type OrderMaterial = "planned" | "building" | "checking" | "built" | "landed" | "scrapped";

export function orderMaterial(state: CaptainOrderState): OrderMaterial {
  switch (state) {
    case "queued":
      return "planned";
    case "running":
    case "landing":
      return "building";
    case "verifying":
    case "reviewing":
      return "checking";
    case "verify_failed":
    case "accepted":
    case "land_failed":
    case "done":
      return "built";
    case "landed":
      return "landed";
    case "dropped":
      return "scrapped";
  }
}

export function isSolidMaterial(material: OrderMaterial): boolean {
  return material !== "planned" && material !== "scrapped";
}

/** True only when the order changed into `landed` under the user's eyes, not when it mounted landed. */
export function justLanded(previous: CaptainOrderState | null, next: CaptainOrderState): boolean {
  return previous !== null && previous !== "landed" && next === "landed";
}
