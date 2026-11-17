#!/usr/bin/env node
// The reflex CLI. Node runs the TypeScript sources directly (type stripping).
// `reflex link` starts the Link, which hosts the Agent layer; every other
// command is an Agent surface that talks to it.
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "link") {
  // The composition root, so the Agent layer's own code never imports the Link.
  process.argv = [process.argv[0], "reflex link", ...rest];
  await import("../../link/bin/reflex-link.ts");
} else if (cmd === "relay") {
  // A Relay of your own (relay/node/bin/reflex-relay.ts): `npx -y github:JohanSardar/reflex#npx relay`.
  process.argv = [process.argv[0], "reflex relay", ...rest];
  await import("../../relay/node/bin/reflex-relay.ts");
} else if (cmd === "setup" || cmd === "pair") {
  // First-time setup and a fresh pairing code (link/bin/setup.ts). A fresh clone has no packages and no
  // dependencies yet: get them first, so this one command is all it takes.
  if (cmd === "setup" && !process.env.REFLEX_BIN) await prepare(); // the single-file build has nothing to install
  process.argv = [process.argv[0], `reflex ${cmd}`, cmd, ...rest];
  await import("../../link/bin/setup.ts");
} else {
  const { main } = await import("../src/surfaces/cli.ts");
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
}

/** Installs packages and the optional peer-to-peer helper if this checkout doesn't have them yet. */
async function prepare() {
  const { existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const root = new URL("../../", import.meta.url);
  const at = (p) => new URL(p, root).pathname;
  const run = (what, file, args) => {
    console.log(`Setting up Reflex: ${what}…`);
    try {
      execFileSync(file, args, { cwd: at("."), stdio: "inherit" });
    } catch {
      console.error(`Error: ${what} failed. Run \`${[file, ...args].join(" ")}\` in ${at(".")} to see why, then \`reflex setup\` again.`);
      process.exit(1);
    }
  };
  if (!existsSync(at("node_modules/bonjour-service"))) run("installing packages (npm install)", "npm", ["install", "--no-audit", "--no-fund"]);
  // Apple peer-to-peer Wi-Fi: the iPad reaches this Mac even on a network that keeps devices apart (campus, hotel).
  if (process.platform === "darwin" && !existsSync(at("link/transports/p2p/.build/release/reflex-p2p"))) {
    try {
      execFileSync("swift", ["--version"], { stdio: "ignore" });
      run("building the peer-to-peer Wi-Fi helper (once)", "swift", ["build", "-c", "release", "--package-path", "link/transports/p2p"]);
    } catch {
      console.log("Setting up Reflex: no Swift (Xcode's command-line tools), so peer-to-peer Wi-Fi stays off; the iPad needs the same network.");
    }
  }
}
