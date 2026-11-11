// The author kit's CLI group (SPEC §12): `reflex create`, `reflex test` and
// `reflex dev`. They work offline and need no Link: they are for people and
// Agents who extend Reflex, not for using a Space.
import { create } from "./create.ts";
import { report, test } from "./test.ts";
import { KINDS, ExtensionFileError } from "../extensions/files.ts";
import type { Kind } from "../extensions/checks.ts";

type Flags = Record<string, string | boolean>;
type Cmd = { usage: string; summary: string; flags?: string[]; run: (pos: string[], f: Flags) => Promise<number> };
type UsageCtor = new (msg: string, next?: string[]) => Error;

const out = (s: string) => process.stdout.write(s + "\n");
const fail = (reason: string, msg: string, fix: string, next: string[] = []) =>
  process.stderr.write(JSON.stringify({ ok: false, reason, errors: [{ code: reason, msg, fix }], ...(next.length ? { next } : {}) }) + "\n");

export function authorCommands(Usage: UsageCtor): Record<string, Cmd> {
  return {
    create: {
      usage: "reflex create guide|recipe|embed|adapter <name> [--dir <path>]",
      summary: "Write a working example extension of one kind, ready for reflex test and reflex dev",
      flags: ["dir"],
      run: async (p, f) => {
        const [kind, name] = p;
        if (!KINDS.includes(kind as Kind)) throw new Usage(`Missing or unknown kind '${kind ?? ""}'. Usage: reflex create guide|recipe|embed|adapter <name>`);
        if (!name) throw new Usage("Missing <name>. Usage: reflex create guide|recipe|embed|adapter <name>");
        let made;
        try {
          made = create(kind as Kind, name, typeof f.dir === "string" ? f.dir : ".");
        } catch (e) {
          fail("invalid_input", (e as Error).message, (e as Error).message.includes("exists") ? "Pick another name, or pass --dir." : "Use lowercase letters, digits and dashes.");
          return 1;
        }
        if (f.json) out(JSON.stringify({ ok: true, kind, name, path: made.path, files: made.files }));
        else {
          out(`Created ${kind} ${name}:`);
          for (const file of made.files) out(`  ${file}`);
          out(`Next: reflex test ${made.path}`);
          out(`      reflex dev ${made.path}`);
        }
        return 0;
      },
    },
    test: {
      usage: "reflex test [<path>]",
      summary: "Run the contract checks for an extension's kind, and replay its saved examples",
      run: async (p, f) => {
        let r;
        try {
          r = await test(p[0] ?? ".");
        } catch (e) {
          if (e instanceof ExtensionFileError) {
            fail("invalid_input", e.message, e.fix, ["reflex create guide|recipe|embed|adapter <name>"]);
            return 1;
          }
          throw e;
        }
        if (f.json) out(JSON.stringify(r));
        else for (const line of report(r)) out(line);
        return r.ok ? 0 : 1;
      },
    },
    dev: {
      usage: "reflex dev [<path>] [--port <n>] [--no-open]",
      summary: "Open the playground: the web viewer on an in-memory Space, with hot reload, what the Agent reads, Sends and Anchors",
      flags: ["port", "no-open"],
      run: async (p, f) => {
        const port = f.port === undefined ? 7430 : Number(f.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage(`--port takes a port number, not '${f.port}'.`);
        const { dev } = await import("./dev.ts");
        const d = await dev({ path: p[0], port, open: !f["no-open"], log: (s) => (f.json ? process.stderr.write(s + "\n") : out(s)) });
        if (f.json) out(JSON.stringify({ ok: true, url: d.url }));
        const stop = () => void d.close().then(() => process.exit(130));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return -1; // keep running
      },
    },
  };
}
