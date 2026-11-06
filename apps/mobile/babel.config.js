// Node strips the types, so Metro's workers load the shared brand rename directly.
const { batonBrandBabelPlugin } = require("../../scripts/lib/baton-brand.ts");

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: [batonBrandBabelPlugin],
  };
};
