import { describe, expect, it } from "vite-plus/test";

import { createFirstLoadReveal } from "./firstLoadReveal";

describe("createFirstLoadReveal", () => {
  it("staggers the rows of the first load only", () => {
    const claim = createFirstLoadReveal();
    expect(claim(1_000)).toBe(0);
    expect(claim(1_010)).toBe(30);
    expect(claim(1_020)).toBe(60);
    expect(claim(1_700)).toBeNull();
    expect(claim(1_710)).toBeNull();
  });

  it("stops after a screenful of rows", () => {
    const claim = createFirstLoadReveal();
    const delays = Array.from({ length: 14 }, () => claim(0));
    expect(delays.at(11)).toBe(330);
    expect(delays.at(12)).toBeNull();
  });
});
