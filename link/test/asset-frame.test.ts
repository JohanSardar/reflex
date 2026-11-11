// Two real Links, paired, and one asset bigger than the LAN transport's frame
// limit. The asset must still reach the peer, and asking for it must not break
// the session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Link } from "../link.ts";
import { home } from "../home.ts";
import { LinkClient } from "../rpc/client.ts";
import { AssetStore } from "../storage/assets.ts";

const PEER_WAIT_MS = 20_000;
const ASSET_WAIT_MS = 25_000;

const state = (l: Link): { peers: unknown[]; paired: unknown[] } => l.status() as { peers: unknown[]; paired: unknown[] };

async function until(what: string, ms: number, ok: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

test("a 17 MiB asset syncs to the paired peer and does not break the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "reflex-link-frame-"));
  const logA: string[] = [];
  const logB: string[] = [];
  const a = new Link({ dir: join(root, "a"), port: 0, prompt: false, log: (m) => logA.push(m) });
  const b = new Link({ dir: join(root, "b"), port: 0, prompt: false, log: (m) => logB.push(m) });
  try {
    await a.start();
    await b.start();
    const ca = await LinkClient.connect(a.dir, "admin");
    const cb = await LinkClient.connect(b.dir, "admin");
    try {
      const { uri } = await ca.call<{ uri: string }>("pair.offer");
      await cb.call("pair.join", { uri });
      await until("both Links bound to each other", PEER_WAIT_MS, () => state(a).peers.length > 0 && state(b).peers.length > 0);
      assert.equal(state(b).paired.length, 1);

      // 17 MiB: one byte over the 16 MiB frame limit, once headers are counted.
      const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
      const { hash } = await ca.call<{ hash: string }>("assets.put", { base64: bytes.toString("base64") });

      const assetsB = new AssetStore(home(b.dir).assets);
      let got = false;
      try {
        await until("the asset on the peer", ASSET_WAIT_MS, () => (got = assetsB.has(hash)));
      } catch {
        // reported by the assertion below
      }
      assert.ok(got, `the peer never got asset ${hash} (${bytes.length} bytes); transport limit is 16 MiB per frame`);

      const poisoned = [...logA, ...logB].filter((m) => m.includes("unable to authenticate data"));
      assert.deepEqual(poisoned, [], "asking for the asset made a session undecryptable");
    } finally {
      ca.close();
      cb.close();
    }
  } finally {
    await a.stop();
    await b.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
