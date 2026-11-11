// The person's web viewer, served by the Link (SPEC §3): a browser on this
// computer opens a Space and draws it, live. The browser runs the kernel and
// syncs its replicas with the Link's (agent/src/web/server.ts).
//
// It listens on loopback only. The viewer key is made fresh at every start,
// kept only in memory, and shown only on the Link's own terminal, like a
// pairing code: a process that can read the Link's files can't get it. What a
// browser sends is checked by the kernel with no writers, so the viewer can
// read every Space and change none.
import { serveWeb } from "../agent/src/web/server.ts";
import type { AssetStore } from "./storage/assets.ts";
import type { Catalog } from "./pairing/catalog.ts";
import type { SpaceStore } from "./storage/journal.ts";
import type { HereEntry, HereMessage } from "./here.ts";

export async function startWebViewer(o: {
  store: SpaceStore;
  assets: AssetStore;
  catalog: Catalog;
  person: () => { id: string; name: string };
  /** People in Spaces shared with or by this person, for names. */
  people?: () => { id: string; name: string }[];
  /** Who is in each Space right now (link/here.ts). */
  here?: () => HereEntry[];
  port: number;
  log: (msg: string) => void;
}) {
  const listeners: ((space: string) => void)[] = [];
  o.store.onChange((space) => {
    for (const l of listeners) l(space);
  });
  const web = await serveWeb({
    port: o.port,
    page: "index.html",
    log: o.log,
    source: {
      get person() {
        return o.person();
      },
      names: () => ({
        ...Object.fromEntries(o.catalog.agents().map((a) => [a.id, a.name])),
        ...Object.fromEntries((o.people?.() ?? []).map((p) => [p.id, p.name])),
        [o.person().id]: o.person().name,
      }),
      here: () => (o.here?.() ?? []) as unknown as Record<string, unknown>[],
      spaces: () => o.store.ids().map((id) => ({ id, kind: o.store.kind(id) })),
      read: (space, fn) => o.store.read(space, fn),
      receive: (space, peer, bytes) => JSON.parse(o.store.commit(space, `sync:${peer}`, (s) => s.receiveSyncMessageChecked(peer, bytes, JSON.stringify({ people: [] })))),
      onChange: (fn) => listeners.push(fn),
      asset: (hash) => {
        try {
          return o.assets.has(hash) ? o.assets.get(hash) : undefined;
        } catch {
          return undefined;
        }
      },
    },
  });
  // Live cursors and names go to every viewer as they change; they are never written into a Space.
  return { ...web, here: (m: HereMessage) => web.broadcast({ t: "here", ...m }) };
}
