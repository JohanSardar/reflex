// A push adapter whose live end is a Reflex surface holding a connection to the
// Link (a `listen` frame, link/agent-host.ts): the Claude Code channel and the
// MCP App view. The Link sends each Send Bundle down that connection, and the
// surface answers once the Send reached its harness, or fails it.
import type { Listener } from "../../agent/src/host/server.ts";
import type { Push, PushAdapter, PushOutcome, PushTarget } from "./contract.ts";

export abstract class SurfaceAdapter implements PushAdapter {
  abstract readonly name: string;
  abstract readonly config: Record<string, unknown>;
  #live = new Map<string, { listener: Listener; since: number }>();

  /** A surface's connection is live for `target` until it closes. */
  attach(target: PushTarget, listener: Listener, onClose: () => void) {
    const entry = { listener, since: Date.now() };
    this.#live.set(target.id, entry);
    void listener.closed.then(() => {
      if (this.#live.get(target.id) === entry) this.#live.delete(target.id);
      onClose();
    });
  }

  liveSince(target: PushTarget) {
    return this.#live.get(target.id)?.since;
  }

  async deliver(target: PushTarget, push: Push): Promise<PushOutcome> {
    const live = this.#live.get(target.id);
    if (!live) return { ok: false, reason: "the surface's connection is closed" };
    const r = await live.listener.push(push.bundle, push.images);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "the surface did not take it" };
  }
}
