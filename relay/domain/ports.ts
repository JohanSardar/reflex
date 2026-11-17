// What a room needs from its host: a socket that keeps its state. Node (relay/node) and Cloudflare
// (relay/cloudflare) each provide one, so relay/domain stays the same for both.
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
  /** Where it connected from (the client's IP), for per-address limits. */
  address?: string;
  /** When it connected (ms), for the hello deadline. */
  at?: number;
  /** Whether it has said whom it watches yet (the first time, devices that watch it hear it joined). */
  announced?: boolean;
  /** Recent control messages and new pairing-room channels (ms), for per-minute limits. */
  controls?: number[];
  opens?: number[];
  /** Pairing-room channels it opened ("<device>/<channel>"), the latest few. */
  chans?: string[];
}
