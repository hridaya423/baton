import { describe, expect, it } from "vite-plus/test";

import { justLanded, orderMaterial } from "./orderMaterial";

describe("orderMaterial", () => {
  it.each([
    ["queued", "planned"],
    ["running", "building"],
    ["landing", "building"],
    ["verifying", "checking"],
    ["reviewing", "checking"],
    ["verify_failed", "built"],
    ["accepted", "built"],
    ["land_failed", "built"],
    ["done", "built"],
    ["landed", "landed"],
    ["dropped", "scrapped"],
  ] as const)("%s is %s", (state, material) => {
    expect(orderMaterial(state)).toBe(material);
  });
});

describe("justLanded", () => {
  it("plays only on a change into landed", () => {
    expect(justLanded("landing", "landed")).toBe(true);
    expect(justLanded(null, "landed")).toBe(false);
    expect(justLanded("landed", "landed")).toBe(false);
    expect(justLanded("landing", "land_failed")).toBe(false);
  });
});
