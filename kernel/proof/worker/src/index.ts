// Proof Worker: the TypeScript (Cloudflare Workers) replica of one Space.
//
// One Durable Object holds the replica and keeps its bytes in Durable Object
// storage, so it survives a restart of `wrangler dev`. Same routes as the hub:
// POST /sync/:peer  POST /reset/:peer  POST /agent/:agent/:request  GET /state
import { DurableObject } from "cloudflare:workers";
import { Space } from "../../../wasm/js/workers.ts";

interface Env {
  SPACE: DurableObjectNamespace<SpaceReplica>;
}

const SPACE_ID = "proof";
const ACTOR = "776f726b65722d646f"; // "worker-do"

export class SpaceReplica extends DurableObject<Env> {
  private space: Space | undefined;

  private async open(): Promise<Space> {
    if (this.space) return this.space;
    const saved = await this.ctx.storage.get<Uint8Array>("doc");
    this.space = saved ? Space.load(new Uint8Array(saved), ACTOR) : Space.create(SPACE_ID, "space", ACTOR);
    console.log(`worker: ${saved ? "loaded" : "created"} Space digest=${this.space.digest().slice(0, 12)}`);
    return this.space;
  }

  private async persist(): Promise<void> {
    if (this.space) await this.ctx.storage.put("doc", this.space.save());
  }

  override async fetch(req: Request): Promise<Response> {
    const space = await this.open();
    const parts = new URL(req.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const input = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array();
    switch (parts[0]) {
      case "sync": {
        if (input.length > 0) space.receiveSyncMessage(parts[1], input);
        await this.persist();
        const msg = space.syncMessage(parts[1]);
        return msg ? new Response(new Uint8Array(msg), { headers: { "content-type": "application/octet-stream" } }) : new Response(null, { status: 204 });
      }
      case "reset":
        space.resetSync(parts[1]);
        return new Response(null, { status: 204 });
      case "agent": {
        const r = space.applyAgentBatch(parts[1], parts[2], new TextDecoder().decode(input), Date.now());
        await this.persist();
        return new Response(r, { headers: { "content-type": "application/json" } });
      }
      case "state":
        return Response.json({
          digest: space.digest(),
          heads: JSON.parse(space.heads()),
          scene: JSON.parse(space.scene("{}")),
          memory_bytes: (globalThis as { performance?: { memory?: unknown } }).performance?.memory ?? null,
        });
      default:
        return new Response("not found", { status: 404 });
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const stub = env.SPACE.get(env.SPACE.idFromName(SPACE_ID));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;
