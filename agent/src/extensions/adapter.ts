// Send Adapters (ARCHITECTURE §5): one TypeScript module the Link runs to push
// a Send Bundle somewhere, plus its configuration. The module's default export:
//
//   export default {
//     name: "my-webhook",
//     config: { type: "object", ... },            // JSON Schema for its configuration
//     async deliver(bundle, { config, fetch, log }) { ... return { delivered: true } },
//   };
//
// `fetch` is handed in, so the contract check (and `reflex dev`) can run it
// against a recorder instead of the network.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AdapterExt } from "./files.ts";
import { checkParams, type Problem } from "./checks.ts";

export type Recorded = { url: string; method: string; headers: Record<string, string>; body?: string };
export type Delivered = { result: unknown; requests: Recorded[]; logs: string[]; error?: string; ms: number };

const ajv = new Ajv2020({ strict: false, allErrors: true });
const root = new URL("../../../protocol/", import.meta.url);
const bundleSchema = JSON.parse(readFileSync(new URL("generated/send-bundle.json", root), "utf8"));
const validateBundle = ajv.compile(bundleSchema);
export const exampleBundle = () => JSON.parse(readFileSync(new URL("examples/send-bundle.json", root), "utf8"));

type Module = { name?: unknown; config?: unknown; deliver?: unknown };

async function importFresh(entry: string): Promise<Module> {
  const mod = await import(`${pathToFileURL(entry).href}?t=${Date.now()}`);
  return (mod.default ?? mod) as Module;
}

/** Runs an adapter's deliver once against a recording fetch. Never touches the network. */
export async function deliverDry(ext: AdapterExt, bundle: unknown, ms = 5000): Promise<Delivered> {
  const requests: Recorded[] = [];
  const logs: string[] = [];
  const started = Date.now();
  const fakeFetch = async (url: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = /authorization|token|secret|key/i.test(k) ? "…" : v));
    requests.push({ url: String(url), method: init.method ?? "GET", headers, ...(typeof init.body === "string" ? { body: init.body.slice(0, 20_000) } : {}) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await importFresh(ext.entry);
    if (typeof mod.deliver !== "function") throw new Error("the module's default export has no deliver function");
    const run = (mod.deliver as (b: unknown, c: unknown) => unknown)(structuredClone(bundle), { config: ext.config, fetch: fakeFetch, log: (m: unknown) => logs.push(String(m)) });
    const result = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error(`deliver did not finish within ${ms} ms`)), ms))]);
    return { result, requests, logs, ms: Date.now() - started };
  } catch (e) {
    return { result: undefined, requests, logs, error: (e as Error).message, ms: Date.now() - started };
  }
}

export async function checkAdapter(ext: AdapterExt): Promise<Problem[]> {
  const out: Problem[] = [];
  const err = (code: string, msg: string, fix: string): Problem => ({ level: "error", code, msg, fix });
  if (typeof ext.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(ext.name)) out.push(err("invalid_name", `The name ${JSON.stringify(ext.name)} is not a valid extension name.`, "Use lowercase letters, digits and dashes."));
  if (typeof ext.summary !== "string" || !ext.summary.trim()) out.push(err("missing_summary", "reflex.json has no summary.", "Add a one-line summary."));
  let mod: Module;
  try {
    mod = await importFresh(ext.entry);
  } catch (e) {
    out.push(err("import_failed", `The module doesn't load: ${(e as Error).message}`.slice(0, 400), "Fix the module so `node` can import it."));
    return out;
  }
  if (typeof mod.deliver !== "function") {
    out.push(err("no_deliver", "The module's default export has no deliver(bundle, ctx) function.", "Export default { name, config, async deliver(bundle, { config, fetch, log }) { ... } }."));
    return out;
  }
  if (mod.config !== undefined) {
    const validate = checkParams(mod.config, out, "/config");
    if (validate && !validate(ext.config))
      out.push(err("invalid_config", `reflex.json's config doesn't match the module's config schema: ${ajv.errorsText(validate.errors)}.`, "Fix config in reflex.json."));
  } else out.push({ level: "warning", code: "no_config_schema", msg: "The module exports no config schema.", fix: "Export config: a JSON Schema for the adapter's configuration, so a wrong setting fails early." });
  const bundle = exampleBundle();
  if (!validateBundle(bundle)) out.push(err("internal", "protocol/examples/send-bundle.json doesn't match its schema.", "Run npm run check -w @reflex/protocol."));
  const d = await deliverDry(ext, bundle);
  if (d.error) out.push(err("deliver_failed", `deliver failed on the example Send Bundle: ${d.error}`.slice(0, 400), "Make deliver handle a Bundle like protocol/examples/send-bundle.json."));
  else if (!d.requests.length && (d.result as { delivered?: unknown } | undefined)?.delivered !== true)
    out.push({ level: "warning", code: "nothing_sent", msg: "deliver sent nothing and didn't return { delivered: true }.", fix: "Send the Bundle with ctx.fetch, or return { delivered: true } when it went another way." });
  for (const r of d.requests) if (!/^https:\/\//.test(r.url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(r.url)) out.push(err("insecure_url", `deliver sends to ${r.url} without TLS.`, "Use an https:// URL (plain http only for localhost)."));
  return out;
}
