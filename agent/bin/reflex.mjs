#!/usr/bin/env node
// The reflex CLI. Node runs the TypeScript sources directly (type stripping).
// `reflex link` starts the Link, which hosts the Agent layer; every other
// command is an Agent surface that talks to it.
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "link") {
  // The composition root, so the Agent layer's own code never imports the Link.
  process.argv = [process.argv[0], "reflex link", ...rest];
  await import("../../link/bin/reflex-link.ts");
} else {
  const { main } = await import("../src/surfaces/cli.ts");
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
}
