const BATON_NAME = "Baton";

const UPSTREAM_NAME = "T3 Code";
const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$|\/__tests__\//;

export function rebrand(text: string): string {
  return text
    .replaceAll(`${UPSTREAM_NAME} (Beta)`, BATON_NAME)
    .replaceAll(UPSTREAM_NAME, BATON_NAME);
}

export function batonBrandPlugin() {
  return {
    name: "baton-brand",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (process.env.VITEST) return null;
      const file = id.split("?")[0] ?? id;
      if (file.includes("/node_modules/") || !SOURCE_PATTERN.test(file)) return null;
      if (!code.includes(UPSTREAM_NAME)) return null;
      return { code: rebrand(code), map: null };
    },
    transformIndexHtml(html: string) {
      return rebrand(html);
    },
  };
}

interface BrandedNode {
  value?: unknown;
  extra?: { raw?: unknown; rawValue?: unknown };
}
interface BrandedTemplateElement {
  value: { raw: string; cooked?: string | null };
}
interface BabelPath<Node> {
  node: Node;
}
interface BabelProgramPath {
  traverse(visitor: {
    StringLiteral?(path: BabelPath<BrandedNode>): void;
    JSXText?(path: BabelPath<BrandedNode>): void;
    TemplateElement?(path: BabelPath<BrandedTemplateElement>): void;
  }): void;
}
interface BabelState {
  readonly filename?: string | null | undefined;
  readonly file: { readonly code: string };
}

/**
 * The same rename for Metro. It rewrites string literals, JSX text and template text, not
 * source text, so identifiers and comments are untouched. The visit runs once on Program
 * enter, ahead of React Compiler, which reads literals when it memoizes.
 */
export function batonBrandBabelPlugin() {
  return {
    name: "baton-brand",
    visitor: {
      Program(path: BabelProgramPath, state: BabelState) {
        const file = state.filename?.split("?")[0];
        if (
          !file ||
          file.includes("/node_modules/") ||
          TEST_FILE_PATTERN.test(file) ||
          !SOURCE_PATTERN.test(file) ||
          !state.file.code.includes(UPSTREAM_NAME)
        ) {
          return;
        }
        const rewrite = ({ node }: BabelPath<BrandedNode>) => {
          if (typeof node.value !== "string" || !node.value.includes(UPSTREAM_NAME)) return;
          node.value = rebrand(node.value);
          // The generator prints `extra.raw` when it is present, so a stale copy would win.
          if (node.extra) {
            node.extra.raw = undefined;
            node.extra.rawValue = undefined;
          }
        };
        path.traverse({
          StringLiteral: rewrite,
          JSXText: rewrite,
          TemplateElement({ node }) {
            node.value.raw = rebrand(node.value.raw);
            if (typeof node.value.cooked === "string")
              node.value.cooked = rebrand(node.value.cooked);
          },
        });
      },
    },
  };
}
