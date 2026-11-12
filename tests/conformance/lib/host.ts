// The runner's own side of a session: the scenario Spaces as a Link holds them after
// the Agent built them. The runner uses Reflex's kernel for its replicas; it is the
// reference peer, not the implementation under test.
import { createHash } from "node:crypto";
import { Space } from "../../../kernel/wasm/js/node.ts";
import { AGENT, scenarios, T0, type Scenario } from "./fixtures.ts";

export function hostSpaces(only?: (s: Scenario) => boolean): Map<string, { scenario: Scenario; space: Space }> {
  const out = new Map<string, { scenario: Scenario; space: Space }>();
  for (const s of scenarios().filter(only ?? (() => true))) {
    const space = Space.create(s.space, "space", createHash("sha256").update(`runner ${s.space}`).digest("hex").slice(0, 32));
    s.setup.forEach((batch, i) => {
      const r = JSON.parse(space.applyAgentBatch(AGENT, `setup-${i}`, JSON.stringify(batch), T0));
      if (!r.ok) throw new Error(`${s.file}: setup batch ${i} was rejected: ${JSON.stringify(r.errors)}`);
    });
    out.set(s.space, { scenario: s, space });
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns problems = [] or the time is up; returns the last problems. */
export async function until(ms: number, fn: () => Promise<string[]>): Promise<string[]> {
  const end = Date.now() + ms;
  let last: string[] = ["never checked"];
  while (Date.now() < end) {
    last = await fn().catch((e: Error) => [e.message]);
    if (!last.length) return last;
    await sleep(250);
  }
  return last;
}
