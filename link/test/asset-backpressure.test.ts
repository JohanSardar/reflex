// Two real Links, paired, and a 24 MiB asset. Its 1 MiB parts must go out with
// the Path's backpressure respected: at most a couple of parts may be waiting in
// the socket at once, not the whole asset.
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
const ASSET_WAIT_MS = 40_000;
const MiB = 1024 * 1024;

const state = (l: Link): { peers: { queuedBytes: number }[]; paired: unknown[] } => l.status() as { peers: { queuedBytes: number }[]; paired: unknown[] };

async function until(what: string, ms: number, ok: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

test("a 24 MiB asset goes out in parts that respect backpressure", async () => {
  const root = mkdtempSync(join(tmpdir(), "reflex-link-queue-"));
  const a = new Link({ dir: join(root, "a"), port: 0, prompt: false, log: () => {} });
  const b = new Link({ dir: join(root, "b"), port: 0, prompt: false, log: () => {} });
  const warnings: string[] = [];
  const onWarning = (w: Error): void => void warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    await a.start();
    await b.start();
    const ca = await LinkClient.connect(a.dir, "admin");
    const cb = await LinkClient.connect(b.dir, "admin");
    try {
      const { uri } = await ca.call<{ uri: string }>("pair.offer");
      await cb.call("pair.join", { uri });
      await until("both Links bound to each other", PEER_WAIT_MS, () => state(a).peers.length > 0 && state(b).peers.length > 0);

      const bytes = Buffer.alloc(24 * MiB, 3);
      const { hash } = await ca.call<{ hash: string }>("assets.put", { base64: bytes.toString("base64") });

      // Watch how much the sender is holding in the socket while the asset crosses.
      let peak = 0;
      const sampler = setInterval(() => {
        const peers = state(a).peers;
        if (peers.length) peak = Math.max(peak, peers[0].queuedBytes);
      }, 1);

      const assetsB = new AssetStore(home(b.dir).assets);
      try {
        await until("the asset on the peer", ASSET_WAIT_MS, () => assetsB.has(hash));
      } finally {
        clearInterval(sampler);
      }

      assert.ok(
        peak < 6 * MiB,
        `the sender queued ${(peak / MiB).toFixed(1)} MiB of a ${bytes.length / MiB} MiB asset at once: ` +
          `the 1 MiB parts are written without waiting for the Path to drain`,
      );
      assert.deepEqual(
        warnings.filter((w) => w === "MaxListenersExceededWarning"),
        [],
        "every part waiting on the socket adds drain/close listeners, so they pile up past the limit",
      );
    } finally {
      ca.close();
      cb.close();
    }
  } finally {
    process.off("warning", onWarning);
    await a.stop();
    await b.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
