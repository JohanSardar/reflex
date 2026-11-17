import type { NativeSend } from "../../../link/storage/sends.ts";
import type { Json } from "../protocol.ts";
import type { Assets, Inbox } from "../store.ts";
import { nativeBundle } from "./native-bundle.ts";

export type Identity = { agent: string; name: string; color: string };
export type Ctx = {
  who: Identity;
  signal?: AbortSignal;
  progress?: (p: { elapsed_s: number; timeout_s: number }) => void;
};
export type Result = {
  json: Json;
  images: Buffer[];
  files?: { id: string; name: string; mime: string; data: Buffer }[];
  isError: boolean;
};
export class ReflexError extends Error {
  body: { reason: string; errors: { code: string; msg: string; fix: string }[]; next?: string[] };
  constructor(reason: string, errors: { code: string; msg: string; fix: string }[], next?: string[]) {
    super(errors[0]?.msg ?? reason);
    this.body = { reason, errors, ...(next ? { next } : {}) };
  }
}
export class Core {
  #names = new Map<string, string>();
  readonly opts: {
    inbox: Inbox;
    assets: Assets;
    getSend: (id: string) => NativeSend | undefined;
    person: { person: string; name: string };
    names?: Record<string, string>;
    progressEvery?: number;
    log?: (event: string, data?: Record<string, unknown>) => void;
  };
  constructor(opts: Core["opts"]) {
    this.opts = opts;
    this.#names.set(opts.person.person, opts.person.name);
    for (const [id, name] of Object.entries(opts.names ?? {})) this.#names.set(id, name);
  }
  name(id: string, name: string) {
    if (name) this.#names.set(id, name);
  }
  async call(tool: string, args: unknown, ctx: Ctx): Promise<Result> {
    this.name(ctx.who.agent, ctx.who.name);
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      if (tool !== "wait_for_user") throw new Error("Use wait_for_user to receive the person's Sends.");
      const timeout = a.timeout_s === undefined ? 300 : a.timeout_s;
      if (
        typeof timeout !== "number" ||
        !Number.isFinite(timeout) ||
        timeout < 0 ||
        timeout > 3600 ||
        (a.after !== undefined && typeof a.after !== "string") ||
        (a.space !== undefined && typeof a.space !== "string")
      )
        throw new Error("Pass timeout_s between 0 and 3600, and optional after and space strings.");
      if (typeof a.after === "string") this.opts.inbox.ack(ctx.who.agent, a.after);
      const started = Date.now(),
        deadline = started + timeout * 1000;
      for (;;) {
        const d = this.opts.inbox.take(ctx.who.agent, { ...(typeof a.space === "string" ? { space: a.space } : {}) });
        if (d)
          return { ...this.project(d.send as unknown as NativeSend, ctx.who.agent, d.redelivered), isError: false };
        const left = deadline - Date.now();
        if (left <= 0 || ctx.signal?.aborted) break;
        const tick = new AbortController(),
          stop = () => tick.abort();
        ctx.signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, Math.min(left, (this.opts.progressEvery ?? 15) * 1000));
        try {
          await this.opts.inbox.arrival(ctx.who.agent, tick.signal);
        } finally {
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", stop);
        }
        ctx.progress?.({ elapsed_s: Math.round((Date.now() - started) / 1000), timeout_s: timeout });
      }
      return {
        json: {
          status: "still_waiting",
          pending_sends: this.opts.inbox.pending(ctx.who.agent),
          next: "Call wait_for_user again.",
        },
        images: [],
        isError: false,
      };
    } catch (e) {
      return {
        json: {
          ok: false,
          reason: "invalid_input",
          errors: [
            {
              code: "invalid_input",
              msg: (e as Error).message,
              fix: "Use wait_for_user with after, space and timeout_s.",
            },
          ],
        },
        images: [],
        isError: true,
      };
    }
  }
  project(send: NativeSend, agent: string, redelivered: boolean, pushed = false) {
    const result = nativeBundle(send, {
      personName: this.#names.get(send.by.person) ?? send.by.person,
      others: this.opts.inbox
        .recipients(send.send)
        .filter((id) => id !== agent)
        .map((id) => this.#names.get(id) ?? id),
      redelivered,
      pushed,
      pendingAfter: Math.max(0, this.opts.inbox.pending(agent) - 1),
      asset: (hash) => this.opts.assets.get(hash),
    });
    this.opts.log?.("send_delivered", { agent, send: send.send, marks: result.json.marks.length, pushed, redelivered });
    return result;
  }
  bundleFor(who: Identity, space: string, id: string) {
    const send = this.opts.getSend(id);
    if (!send || send.space !== space) return undefined;
    this.name(who.agent, who.name);
    return this.project(send, who.agent, false, true);
  }
}
