// What the Relay's core needs from the platform it runs on. Cloudflare
// (relay/cloudflare/) gives Durable Object SQLite, hibernatable WebSockets,
// R2 and Durable Object RPC; Node (relay/node/) gives node:sqlite, `ws`, a
// folder and plain objects. The core itself is the same code on both.
import type { Grant } from "./wire.ts";

/** Synchronous SQL, as Durable Object SQLite and node:sqlite both are. */
export interface Sql {
  all<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[];
  run(query: string, ...params: unknown[]): void;
}

/** Sealed blobs (R2, or a folder). */
export interface Bucket {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
}

/** One WebSocket in a room, with the state it carries across hibernation. */
export interface Sock {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  get state(): SockState;
  set state(s: SockState);
}

export interface SockState {
  nonce: string;
  device?: string;
  watch: string[];
  logs: string[];
}

/** A log, as a room reaches it (another Durable Object, or an object in the same process). */
export interface LogApi {
  append(token: string, room: string, entries: string[]): Promise<{ seqs: number[] }>;
  read(token: string, after: number, limit: number): Promise<{ entries: { seq: number; data: string }[]; last: number }>;
  watch(token: string, room: string): Promise<{ last: number }>;
  assetsHave(token: string, ids: string[]): Promise<{ have: string[] }>;
  issueGrant(token: string, grant: Grant, sig: string, key: string, code: string): Promise<void>;
  revokeGrant(token: string, grant: string): Promise<void>;
  /** Called by the OAuth token endpoint: turns an approved grant into an access token. */
  mint(grant: string, code: string): Promise<{ token: string; expires: number }>;
}

export interface AuthApi {
  lookup(code: string): Promise<{ client: string; client_uri: string | null; scope: string }>;
  approve(code: string, log: string, grant: string, expires: number): Promise<void>;
}

/** A room, as a log reaches it to say something new arrived. */
export interface RoomApi {
  notify(log: string, last: number): Promise<void>;
}

export interface Hubs {
  log(id: string): LogApi;
  auth(): AuthApi;
  room(id: string): RoomApi;
}
