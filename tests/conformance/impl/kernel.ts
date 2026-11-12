// Reflex's kernel (kernel/wasm, the same Rust crate the iPad, the Link, the Relay
// and the web viewer run) behind the kernel profile's driver requests.
//
//   node tests/conformance/run.ts kernel --impl "node tests/conformance/impl/kernel.ts"
import { Space } from "../../../kernel/wasm/js/node.ts";
import { createHash } from "node:crypto";
import { serve } from "../lib/driver.ts";

const replicas = new Map<string, Space>();
// A stable actor per replica name, so a run is the same every time.
const actor = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 32);
const get = (r: string) => {
  const s = replicas.get(r);
  if (!s) throw new Error(`no replica '${r}'`);
  return s;
};
const parse = (s: string) => JSON.parse(s);

serve({
  create: ({ replica, space, kind }) => void replicas.set(replica, Space.create(space, kind ?? "space", actor(replica))),
  agent: ({ replica, agent, request, batch, now }) => ({ result: parse(get(replica).applyAgentBatch(agent, request, JSON.stringify(batch), now)) }),
  intent: ({ replica, person, device, intent, now }) => ({ result: parse(get(replica).applyUserIntent(person, device, JSON.stringify(intent), now)) }),
  undo: ({ replica, person, device, now }) => ({ result: parse(get(replica).undo(person, device, now)) }),
  redo: ({ replica, person, device, now }) => ({ result: parse(get(replica).redo(person, device, now)) }),
  freeze: ({ replica, person, device, raw, now }) => ({ result: parse(get(replica).freezeSend(person, device, JSON.stringify(raw), now)) }),
  marks: ({ replica, send, viewer }) => ({ result: parse(get(replica).marks(send, JSON.stringify(viewer ? { viewer } : {}))) }),
  scene: ({ replica, query }) => ({ result: parse(get(replica).scene(JSON.stringify(query ?? {}))) }),
  sync_message: ({ replica, peer }) => {
    const m = get(replica).syncMessage(peer);
    return { msg: m ? Buffer.from(m).toString("base64") : null };
  },
  receive: ({ replica, peer, msg, writers }) => {
    const bytes = Buffer.from(msg, "base64");
    if (writers === undefined) return void get(replica).receiveSyncMessage(peer, bytes);
    return { result: parse(get(replica).receiveSyncMessageChecked(peer, bytes, JSON.stringify(writers))) };
  },
  restart: ({ replica }) => void replicas.set(replica, Space.load(get(replica).save(), actor(replica))),
  state: ({ replica }) => ({ digest: get(replica).digest(), heads: parse(get(replica).heads()) }),
});
