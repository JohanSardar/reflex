// Builds dist/reflex.mjs: the whole reflex CLI (MCP server, Link, everything) in one file with its packages, so
//   npx -y github:jujdontbudge/reflex mcp
// runs it with nothing to install. Node won't strip types from files under node_modules, which is where npx puts
// a package, so the TypeScript sources can't run from there. Rebuild with `npm run build` and commit the result.
import { build } from "esbuild";

await build({
  entryPoints: ["agent/bin/reflex.mjs"],
  outfile: "dist/reflex.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  banner: {
    js: [
      "// Built by agent/build.mjs from https://github.com/jujdontbudge/reflex. Don't edit: run `npm run build`.",
      'import { createRequire as __reflexRequire } from "node:module";',
      'import { fileURLToPath as __reflexPath } from "node:url";',
      "const require = __reflexRequire(import.meta.url);",
      "process.env.REFLEX_BIN ??= __reflexPath(import.meta.url);",
    ].join("\n"),
  },
});
