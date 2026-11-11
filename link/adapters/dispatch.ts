// Pushes new Sends to Agents through their live push targets (contract.ts).
//
// It runs after every Inbox arrival, on the next turn of the event loop, so a
// wait_for_user that matches the Send has already taken it: a waiting Agent
// gets its Send from the wait, and only an Agent that isn't waiting gets a
// push. A Send is pushed at most once per recipient, only if it arrived after
// the target went live, and only while nothing else delivered it. While a push
// is in flight, wait_for_user skips that Send (`inFlight`), so it is never
// delivered twice. A push that fails leaves its receipt `failed` (recoverable):
// the next wait_for_user returns it. An adapter with `retries` (the webhook)
// tries again after each wait while the Send is still `ready`, and marks it
// `failed` only after the last try.
import type { Inbox } from "../storage/inbox.ts";
import { recipient } from "../routing.ts";
import type { Push, PushAdapter, PushOutcome, PushTarget } from "./contract.ts";
import type { PushStore } from "./store.ts";

export interface DispatcherOptions {
  inbox: Inbox;
  store: PushStore;
  adapters: PushAdapter[];
  /** The Send Bundle an Agent would get from wait_for_user, or undefined when it can't be built. */
  bundle: (agent: string, space: string, send: string) => Promise<Omit<Push, "space" | "send"> | undefined> | Omit<Push, "space" | "send"> | undefined;
  /** Whether the person still approves this Agent. */
  approved: (agent: string) => boolean;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export class Dispatcher {
  #o: DispatcherOptions;
  #inFlight = new Set<string>();
  /** Sends whose push failed and will be tried again: by Send and recipient, which target, how many tries, when. */
  #retries = new Map<string, { target: string; tries: number; due: number }>();
  #scheduled = false;
  #running: Promise<void> = Promise.resolve();
  #stop = new AbortController();

  constructor(o: DispatcherOptions) {
    this.#o = o;
  }

  /** Whether a push of this Send to this recipient is under way. */
  inFlight(space: string, send: string, to: string) {
    return this.#inFlight.has(`${space}|${send}|${to}`);
  }

  start() {
    const loop = async () => {
      while (!this.#stop.signal.aborted) {
        await this.#o.inbox.next(this.#stop.signal);
        this.kick();
      }
    };
    void loop();
  }

  stop() {
    this.#stop.abort();
  }

  /** Runs a pass after the waits the arrival woke have taken their Sends. */
  kick() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      this.#running = this.#running.then(() => this.#pass()).catch((e) => this.#o.log("push_error", { error: String((e as Error).stack ?? e) }));
    });
  }

  /** The live target each Agent's Sends go to: its most recently seen one. */
  #targets(): { target: PushTarget; adapter: PushAdapter; since: number }[] {
    const out = new Map<string, { target: PushTarget; adapter: PushAdapter; since: number }>();
    for (const target of this.#o.store.all()) {
      if (out.has(target.agent)) continue;
      const adapter = this.#o.adapters.find((a) => a.name === target.adapter);
      const since = adapter?.liveSince(target);
      if (adapter && since !== undefined) out.set(target.agent, { target, adapter, since });
    }
    return [...out.values()];
  }

  async #pass() {
    // Targets are pushed to side by side, so a slow webhook doesn't hold up another Agent's channel.
    await Promise.all(this.#targets().map((t) => this.#pushTo(t.target, t.adapter, t.since)));
  }

  async #pushTo(target: PushTarget, adapter: PushAdapter, since: number) {
    const { inbox, store, log } = this.#o;
    if (!this.#o.approved(target.agent)) return;
    const to = recipient(target.agent);
    for (const e of inbox.pending(to)) {
      const key = `${e.space}|${e.send}|${to}`;
      const retry = this.#retries.get(key);
      // Something else delivered it (a wait_for_user, between tries): no more tries.
      if (e.state !== "ready") {
        this.#retries.delete(key);
        continue;
      }
      if (e.arrived_at < since || this.#inFlight.has(key)) continue;
      if (retry) {
        if (retry.target !== target.id || Date.now() < retry.due) continue;
      } else if (store.tried(e.space, e.send, to)) continue; // only Sends never pushed
      if (adapter.liveSince(target) === undefined) break;
      const attempt = (retry?.tries ?? 0) + 1;
      this.#inFlight.add(key);
      const seq = store.begin(target, e.space, e.send, to);
      const started = Date.now();
      let outcome: PushOutcome;
      try {
        const built = await this.#o.bundle(target.agent, e.space, e.send);
        outcome = built
          ? await adapter.deliver(target, { space: e.space, send: e.send, ...built }, { secret: target.has_secret ? store.secret(target.id) : undefined, attempt, log: (m) => log("push_log", { target: target.id, m }) })
          : { ok: false, reason: "the Send could not be read" };
      } catch (err) {
        outcome = { ok: false, reason: String((err as Error).message ?? err).slice(0, 300) };
      } finally {
        this.#inFlight.delete(key);
      }
      const wait = !outcome.ok && outcome.retry ? adapter.retries?.[attempt - 1] : undefined;
      if (outcome.ok) {
        this.#retries.delete(key);
        inbox.mark(e.space, e.send, to, "delivered");
        store.end(seq, "pushed");
        store.touch(target.id);
      } else if (wait !== undefined) {
        // Left `ready` between tries, so wait_for_user can still take it; the next pass after `wait` tries again.
        this.#retries.set(key, { target: target.id, tries: attempt, due: Date.now() + wait });
        setTimeout(() => this.kick(), wait).unref?.();
        store.end(seq, "failed", `${outcome.reason}; try ${attempt}, again in ${Math.round(wait / 1000)} s`);
      } else {
        this.#retries.delete(key);
        inbox.mark(e.space, e.send, to, "failed", `push: ${outcome.reason}`);
        store.end(seq, "failed", outcome.reason);
      }
      log("push", { target: target.id, adapter: adapter.name, agent: target.agent, space: e.space, send: e.send, attempt, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason, ...(wait !== undefined ? { retry_in_ms: wait } : {}) }), ms: Date.now() - started });
    }
  }
}
