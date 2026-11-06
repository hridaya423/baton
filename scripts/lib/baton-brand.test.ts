import { describe, expect, it } from "vite-plus/test";

import { batonBrandBabelPlugin, rebrand } from "./baton-brand.ts";

type Literal = { value: string; extra?: { raw?: unknown; rawValue?: unknown } };

function run(filename: string, code: string, literals: Array<Literal>) {
  const { visitor } = batonBrandBabelPlugin();
  const template = { value: { raw: "Install T3 Code", cooked: "Install T3 Code" } };
  visitor.Program(
    {
      traverse(visit) {
        for (const node of literals) {
          visit.StringLiteral?.({ node });
          visit.JSXText?.({ node });
        }
        visit.TemplateElement?.({ node: template });
      },
    },
    { filename, file: { code } },
  );
  return template;
}

describe("rebrand", () => {
  it("drops the Beta suffix before renaming", () => {
    expect(rebrand("T3 Code (Beta) and T3 Code")).toBe("Baton and Baton");
  });
});

describe("batonBrandBabelPlugin", () => {
  it("renames literals and clears the raw copy the generator would print", () => {
    const literal: Literal = {
      value: "T3 Code, Threads",
      extra: { raw: '"T3 Code, Threads"', rawValue: "T3 Code, Threads" },
    };
    const template = run("/repo/apps/mobile/src/Home.tsx", "T3 Code", [literal]);
    expect(literal.value).toBe("Baton, Threads");
    expect(literal.extra?.raw).toBeUndefined();
    expect(template.value).toEqual({ raw: "Install Baton", cooked: "Install Baton" });
  });

  it.each([
    "/repo/node_modules/some-lib/index.js",
    "/repo/apps/mobile/src/Home.test.tsx",
    "/repo/apps/mobile/src/styles.css",
  ])("leaves %s alone", (filename) => {
    const literal: Literal = { value: "T3 Code" };
    const template = run(filename, "T3 Code", [literal]);
    expect(literal.value).toBe("T3 Code");
    expect(template.value.raw).toBe("Install T3 Code");
  });
});
