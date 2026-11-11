// The push Send Adapter contract (ARCHITECTURE §6, "Send delivery"; ADR-0002).
//
// wait_for_user and the Inbox are the guaranteed path. A push adapter is an
// add-on that carries a Send Bundle to an Agent that isn't waiting. The Link
// owns everything durable about a push, so an adapter is only the last step:
//
//   - a target: which Agent, through which adapter, with what config, and
//     where the receiving side calls back (link/adapters/store.ts);
//   - its secret, kept by the Link in a 0600 file, handed to the adapter at
//     delivery time and never stored in the target's config;
//   - every delivery attempt, recorded before and after the adapter runs.
//
// A push that fails, times out or isn't supported leaves the Send in the
// Inbox, so wait_for_user still returns it. A push that worked counts as one
// delivery (receipt `delivered`). The Send stays pending until the Agent
// acknowledges it (in_reply_to or after), like one wait_for_user returned.
import type { Bounds } from "../../agent/src/store.ts";

/** Where one Agent's Sends are pushed. */
export interface PushTarget {
  id: string;
  /** The Agent's principal ID. */
  agent: string;
  /** The adapter that delivers to it, such as `claude-channel`. */
  adapter: string;
  /** The adapter's settings, checked against its `config` schema. No secrets. */
  config: Record<string, unknown>;
  /**
   * How the receiving side answers. Every adapter's receiver replies with Reflex tools (`apply(in_reply_to)`,
   * `wait_for_user(after)`), over MCP or the CLI: `mcp` for a session or view on an MCP connection, `tools`
   * for a webhook receiver that calls them itself.
   */
  callback: string;
  /** Whether the Link holds a secret for this target. */
  has_secret: boolean;
  created_at: number;
  /** Last time this target was live or used. */
  seen_at: number;
}

/** One Send Bundle as the Agent would get it from wait_for_user, with its images. */
export interface Push {
  space: string;
  send: string;
  bundle: Record<string, any> & { images?: { n: number; shows: string; bounds: Bounds }[] };
  images: Buffer[];
}

/** `retry`: the failure may pass (a network error, a timeout, a 5xx), so the dispatcher may try again. */
export type PushOutcome = { ok: true } | { ok: false; reason: string; retry?: boolean };

export interface PushAdapter {
  /** The adapter's name, stored on each target. */
  readonly name: string;
  /** A JSON Schema for a target's config. */
  readonly config: Record<string, unknown>;
  /**
   * Waits (ms) before each retry of a push that failed with `retry`; none when absent. Between tries the Send
   * stays `ready`, so a wait_for_user can still take it, and then no retry runs.
   */
  readonly retries?: number[];
  /**
   * Whether this target can take a push right now (a live session, a reachable URL): the time it became
   * live, or undefined. Only Sends that arrive after that are pushed; older ones wait in the Inbox.
   */
  liveSince(target: PushTarget): number | undefined;
  /** Delivers one Send. Never throws: a failure is an outcome, and the Send stays in the Inbox. */
  deliver(target: PushTarget, push: Push, ctx: { secret?: string; attempt: number; log: (m: string) => void }): Promise<PushOutcome>;
}
