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
}
