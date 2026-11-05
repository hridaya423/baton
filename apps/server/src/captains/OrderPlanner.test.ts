import { assert, it } from "@effect/vitest";
import { CaptainOrderId } from "@t3tools/contracts";

import { globsOverlap, ordersOverlap, selectAdmissions, slug } from "./OrderPlanner.ts";

const id = (name: string) => CaptainOrderId.make(`order:${name}`);

const order = (
  name: string,
  fields: {
    readonly kind?: "change" | "report";
    readonly touches?: ReadonlyArray<string>;
    readonly dependsOn?: ReadonlyArray<string>;
    readonly state?: "queued" | "running" | "done" | "dropped";
  } = {},
) => ({
  id: id(name),
  kind: fields.kind ?? "change",
  touches: fields.touches ?? [`${name}/`],
  dependsOn: (fields.dependsOn ?? []).map(id),
  state: fields.state ?? "queued",
});

it("treats two globs as overlapping unless no path can match both", () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["README.md", "README.md", true],
    ["README.md", "docs/**", false],
    ["docs/**", "docs/guide/*.md", true],
    ["docs/guide/*.md", "docs/**", true],
    ["src/web/**", "src/server/**", false],
    ["./src/**", "src/index.ts", true],
    ["**/*.ts", "src/index.ts", true],
    ["*.md", "docs/a.md", true],
    ["apps/server/**", "apps/web/**", false],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(globsOverlap(left, right), expected, `${left} vs ${right}`);
  }
});

it("lets reports run beside anything and holds unknown change orders back", () => {
  assert.isFalse(ordersOverlap({ kind: "report", touches: [] }, { kind: "change", touches: [] }));
  assert.isFalse(ordersOverlap({ kind: "change", touches: [] }, { kind: "report", touches: [] }));
  assert.isTrue(ordersOverlap({ kind: "change", touches: [] }, { kind: "change", touches: ["a"] }));
  assert.isTrue(ordersOverlap({ kind: "change", touches: ["a"] }, { kind: "change", touches: [] }));
  assert.isFalse(
    ordersOverlap({ kind: "change", touches: ["a/"] }, { kind: "change", touches: ["b/"] }),
  );
  assert.isTrue(
    ordersOverlap(
      { kind: "change", touches: ["a/", "shared/**"] },
      { kind: "change", touches: ["b/", "shared/x.ts"] },
    ),
  );
});

it("admits oldest first within the crew cap, holding overlap and unmet dependencies", () => {
  const orders = [
    order("running", { state: "running", touches: ["core/**"] }),
    order("overlaps-running", { touches: ["core/a.ts"] }),
    order("disjoint-a", { touches: ["docs/**"] }),
    order("disjoint-b", { touches: ["docs/guide/**"] }),
    order("needs-dep", { dependsOn: ["unfinished"], touches: ["site/**"] }),
    order("report", { kind: "report", touches: [] }),
  ];
  assert.deepEqual(selectAdmissions({ crewCap: 3, orders }), [id("disjoint-a"), id("report")]);
  assert.deepEqual(selectAdmissions({ crewCap: 2, orders }), [id("disjoint-a")]);
  assert.deepEqual(selectAdmissions({ crewCap: 1, orders }), []);
});

it("admits an order once everything it depends on is done", () => {
  const blocked = [order("a", { state: "running" }), order("b", { dependsOn: ["a"] })];
  assert.deepEqual(selectAdmissions({ crewCap: 3, orders: blocked }), []);
  const ready = [order("a", { state: "done" }), order("b", { dependsOn: ["a"] })];
  assert.deepEqual(selectAdmissions({ crewCap: 3, orders: ready }), [id("b")]);
  const dropped = [order("a", { state: "dropped" }), order("b", { dependsOn: ["a"] })];
  assert.deepEqual(selectAdmissions({ crewCap: 3, orders: dropped }), []);
});

it("counts orders admitted in the same pass against the cap and against each other", () => {
  const orders = [
    order("first", { touches: ["shared/**"] }),
    order("second", { touches: ["shared/x.ts"] }),
    order("third", { touches: ["other/**"] }),
  ];
  assert.deepEqual(selectAdmissions({ crewCap: 3, orders }), [id("first"), id("third")]);
});

it("builds branch-safe slugs", () => {
  assert.equal(slug("Juice up the README!", 24), "juice-up-the-readme");
  assert.equal(slug("  ---  ", 24), "order");
  assert.equal(slug("A very long order title that goes on", 12), "a-very-long");
});
