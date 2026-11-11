// Proof hub: the TypeScript (Node) replica of one Space.
//
// It is a stand-in for Reflex Link, only for proving the kernel: it keeps its
// replica on disk, speaks the kernel's sync protocol over HTTP to the iPad app
// (peer "ipad"), and syncs with the Workers replica (peer "worker").
//
//   node kernel/proof/node/hub.ts            # listens on 127.0.0.1:7311
//
// Routes: POST /sync/:peer  POST /reset/:peer  POST /agent/:agent/:request
//         POST /intent/:person/:device  POST /send/:person/:device
//         POST /relay (sync with the Worker)  GET /state
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { Space } from "../../wasm/js/node.ts";

const SPACE_ID = "proof";
const ACTOR = "6875622d6e6f6465"; // "hub-node": this replica's actor, kept across restarts
const STORE = process.env.HUB_STORE ?? new URL("../.data/hub.automerge", import.meta.url).pathname;
const WORKER = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const PORT = Number(process.env.PORT ?? 7311);

let space: Space;
if (existsSync(STORE)) {
  space = Space.load(readFileSync(STORE), ACTOR);
  console.log(`hub: loaded ${STORE} digest=${space.digest().slice(0, 12)}`);
} else {
  space = Space.create(SPACE_ID, "space", ACTOR);
  console.log(`hub: created Space ${SPACE_ID}`);
}

function persist(): void {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, space.save());
}

async function body(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function json(res: ServerResponse, v: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(typeof v === "string" ? v : JSON.stringify(v));
}

function state(): { digest: string; heads: string[]; scene: unknown } {
  return { digest: space.digest(), heads: JSON.parse(space.heads()), scene: JSON.parse(space.scene("{}")) };
}

// Hub as sync client of the Worker: send our message, take its reply, until both are quiet.
async function relay(): Promise<number> {
  space.resetSync("worker");
  await fetch(`${WORKER}/reset/hub`, { method: "POST" });
  let rounds = 0;
  for (; rounds < 50; rounds++) {
    const out = space.syncMessage("worker");
    const r = await fetch(`${WORKER}/sync/hub`, { method: "POST", body: new Uint8Array(out ?? []) });
    if (r.status === 200) space.receiveSyncMessage("worker", new Uint8Array(await r.arrayBuffer()));
    if (!out && r.status === 204) break;
  }
  persist();
  return rounds;
}

const now = (): number => Date.now();

createServer(async (req, res) => {
  try {
    const parts = (req.url ?? "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
    const input = req.method === "POST" ? await body(req) : new Uint8Array();
    const text = new TextDecoder().decode(input);
    switch (parts[0]) {
      case "sync": {
        if (input.length > 0) space.receiveSyncMessage(parts[1], input);
        persist();
        const msg = space.syncMessage(parts[1]);
        if (msg) {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.from(msg));
        } else {
          res.writeHead(204).end();
        }
        return;
      }
      case "reset":
        space.resetSync(parts[1]);
        res.writeHead(204).end();
        return;
      case "agent": {
        const r = space.applyAgentBatch(parts[1], parts[2], text, now());
        persist();
        console.log(`hub: agent ${parts[1]} ${parts[2]} -> ${r}`);
        return json(res, r);
      }
      case "intent": {
        const r = space.applyUserIntent(parts[1], parts[2], text, now());
        persist();
        return json(res, r);
      }
      case "send": {
        const r = space.freezeSend(parts[1], parts[2], text, now());
        persist();
        return json(res, r);
      }
      case "relay": {
        const rounds = await relay();
        return json(res, { rounds, ...state() });
      }
      case "state":
        return json(res, state());
      default:
        res.writeHead(404).end();
    }
  } catch (e) {
    console.error("hub error:", e);
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`hub: listening on http://127.0.0.1:${PORT}`));
