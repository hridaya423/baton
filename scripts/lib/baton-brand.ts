const BATON_NAME = "Baton";

const UPSTREAM_NAME = "T3 Code";
const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/;

function rebrand(text: string): string {
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
