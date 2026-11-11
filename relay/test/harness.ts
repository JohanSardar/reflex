// Review harness: an in-process Node Relay (relay/node/server.ts) plus the Link's
// own relay-side classes (link/relay/sync.ts, link/transports/relay.ts), wired
// the way link/link.ts wires them, and the OAuth dance a cloud MCP client does.
// Nothing here is a test; the tests next to it use it.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { identity, home } from "../../link/home.ts";
import { Catalog } from "../../link/pairing/catalog.ts";
import { RelaySync, type GrantRecord } from "../../link/relay/sync.ts";
import { AssetStore } from "../../link/storage/assets.ts";
import { openDb } from "../../link/storage/db.ts";
import { Inbox } from "../../link/storage/inbox.ts";
import { SpaceStore } from "../../link/storage/journal.ts";
import { RelayTransport, roomFor } from "../../link/transports/relay.ts";
import { startRelay } from "../node/server.ts";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(what: string, ms: number, ok: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ok()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

const b64url = (b: Buffer): string => b.toString("base64url");

export interface Review {
  dir: string;
  relay: RelayRun;
  /** The Link's side: its Space store, its log, its grants. */
  store: SpaceStore;
  sync: RelaySync;
  transport: RelayTransport;
  db: DatabaseSync;
  /** Makes a Space on the Link and leaves it in the log (the way an issued grant expects). */
  space(id: string): Promise<void>;
  /** A person's Send on the Link, pushed to the log. */
  send(id: string, said: string): Promise<void>;
  /** A sign-in the person is approving: register a client, open its page, read its code. */
  signIn(client: string): Promise<SignIn>;
  /** The token a cloud client gets once the Link issued its grant. */
  token(signIn: SignIn, grant: GrantRecord): Promise<string>;
  call(token: string, tool: string, args: unknown): Promise<CallResult>;
  close(): Promise<void>;
}

export interface RelayRun {
  port: number;
  http: string;
  close(): Promise<void>;
}

export interface SignIn {
  clientId: string;
  verifier: string;
  code: string;
  poll: string;
}

export interface CallResult {
  status: number;
  isError: boolean | undefined;
  text: string;
  json: Record<string, unknown> | null;
}

export async function startRelayAt(dir: string, port = 0): Promise<RelayRun> {
  const relay = await startRelay({ dir, port, log: () => {} });
  return { port: relay.port, http: `http://127.0.0.1:${relay.port}`, close: relay.close };
}

export async function setup(name: string): Promise<Review> {
  const dir = mkdtempSync(join(tmpdir(), `reflex-review-${name}-`));
  const relay = await startRelayAt(join(dir, "relay"));
  const linkDir = join(dir, "link");
  const id = identity(linkDir);
  const h = home(linkDir);
  const db = openDb(h.db);
  const inbox = new Inbox(db);
  const store = new SpaceStore(db, id.actor, inbox);
  inbox.recipientsFor = () => [];
  const assets = new AssetStore(h.assets);
  const catalog = new Catalog(db, id.key);
  store.recover();
  const transport = new RelayTransport({ url: `ws://127.0.0.1:${relay.port}`, key: id.key, room: () => roomFor(id.person.id), watch: () => [], log: () => {} });
  const sync = new RelaySync({ db, store, assets, catalog, transport, key: id.key, person: () => id.person, connected: () => false, log: () => {} });
  await transport.listen(() => {});
  await until("the Link to reach the Relay", 10_000, () => transport.connected);

  const api: Review = {
    dir,
    relay,
    store,
    sync,
    transport,
    db,
    async space(sid) {
      store.ensure(sid, "space");
      // The store's debounced push needs a moment before the Space is in the log.
      await sleep(500);
    },
    async send(sid, said) {
      store.commit(sid, "send", (s) => s.freezeSend(id.person.id, id.key.device, JSON.stringify({ send: "s_" + randomBytes(4).toString("hex"), said }), Date.now()));
      // Pushed by the store's own debounce (300 ms).
      await sleep(900);
    },
    async signIn(client) {
      const reg = (await (
        await fetch(`${relay.http}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: client, redirect_uris: ["http://127.0.0.1:9999/cb"] }) })
      ).json()) as { client_id: string };
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const url = `${relay.http}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/cb")}&code_challenge=${challenge}&code_challenge_method=S256`;
      const page = await (await fetch(url)).text();
      const code = /id="code">([A-Z0-9-]+)</.exec(page)?.[1];
      const poll = /fetch\("([^"]+)"\)/.exec(page)?.[1];
      if (!code || !poll) throw new Error("the sign-in page has no code");
      return { clientId: reg.client_id, verifier, code, poll };
    },
    async token(signIn, grant) {
      const go = await fetch(`${signIn.poll}?go=1`, { redirect: "manual" });
      const authCode = new URL(go.headers.get("location") ?? "").searchParams.get("code");
      const r = await (
        await fetch(`${relay.http}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: authCode ?? "",
            client_id: signIn.clientId,
            redirect_uri: "http://127.0.0.1:9999/cb",
            code_verifier: signIn.verifier,
          }),
        })
      ).json();
      const token = (r as { access_token?: string }).access_token;
      if (!token) throw new Error(`no access token for ${grant.gid}: ${JSON.stringify(r)}`);
      return token;
    },
    async call(token, tool, args) {
      const r = await fetch(`${relay.http}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const body = await r.text();
      const first = body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean } })
        .at(0);
      const text = first?.result?.content?.find((c) => c.type === "text")?.text ?? body;
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { status: r.status, isError: first?.result?.isError, text, json };
    },
    async close() {
      await transport.close();
      await relay.close();
    },
  };
  return api;
}

/** Grants `client` the Space, the way the person does it from the Link's terminal. */
export async function grantTo(r: Review, space: string, client: string, ms = 3_600_000): Promise<{ token: string; grant: GrantRecord; signIn: SignIn }> {
  const signIn = await r.signIn(client);
  const grant = await r.sync.issue(signIn.code, space, ms, client);
  return { token: await r.token(signIn, grant), grant, signIn };
}
