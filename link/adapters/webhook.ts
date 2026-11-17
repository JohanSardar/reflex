// The webhook adapter: a push Send Adapter for custom harnesses (SPEC §9).
//
// `reflex adapters add webhook --url <url>` makes a target for the Agent that
// ran it. The Link POSTs each new Send Bundle there as JSON, signed with the
// target's own secret (kept by the Link, link/adapters/store.ts). A 2xx answer
// is the receiver's acknowledgement that it took the Send: the push counts as
// one delivery, and the Agent then answers it with Reflex tools as usual
// ( `wait_for_user(after)`). A network error, a timeout
// or a 5xx/429 is tried again after 1 s and 5 s; any other answer, or the last
// failure, leaves the Send in the Inbox for wait_for_user.
//
// The request:
//   POST <url>
//   content-type: application/json
//   reflex-delivery: <space>/<send>      the same on every try, so a receiver can drop repeats
//   reflex-attempt: 1..3
//   reflex-timestamp: <ms since the epoch>
//   reflex-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
//   { "type": "send", "delivery", "target", "agent", "attempt", "bundle" }
// `bundle` is what wait_for_user returns; each `images[i]` also carries its PNG
// as base64 `data`.
import { createHmac } from "node:crypto";
import type { Push, PushAdapter, PushOutcome, PushTarget } from "./contract.ts";

/** How long one try waits for the receiver's answer. */
const TIMEOUT_MS = Number(process.env.REFLEX_WEBHOOK_TIMEOUT_S ?? 5) * 1000;

export class Webhook implements PushAdapter {
  readonly name = "webhook";
  readonly config = {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", pattern: "^https?://", maxLength: 2048, description: "Where each Send Bundle is POSTed." },
    },
    additionalProperties: false,
  };
  readonly retries = [1000, 5000];

  /** A webhook is always reachable as far as the Link knows; whether it answers is found out by trying. */
  liveSince(target: PushTarget) {
    return target.created_at;
  }

  async deliver(
    target: PushTarget,
    push: Push,
    ctx: { secret?: string; attempt: number; log: (m: string) => void },
  ): Promise<PushOutcome> {
    if (!ctx.secret) return { ok: false, reason: "the target has no signing secret" };
    const url = String(target.config.url);
    const bundle = {
      ...push.bundle,
      images: (push.bundle.images ?? []).map((img, i) => ({
        ...img,
        mime: "image/png",
        data: push.images[i]?.toString("base64"),
      })),
    };
    const body = JSON.stringify({
      type: "send",
      delivery: `${push.space}/${push.send}`,
      target: target.id,
      agent: target.agent,
      attempt: ctx.attempt,
      bundle,
    });
    const timestamp = String(Date.now());
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "reflex-link/0.1",
          "reflex-delivery": `${push.space}/${push.send}`,
          "reflex-attempt": String(ctx.attempt),
          "reflex-timestamp": timestamp,
          "reflex-signature": sign(ctx.secret, timestamp, body),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true };
      const retry = res.status >= 500 || res.status === 429 || res.status === 408;
      return { ok: false, reason: `the receiver answered ${res.status}`, retry };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const reason =
        err.name === "TimeoutError"
          ? `no answer within ${TIMEOUT_MS / 1000} s`
          : `could not reach it (${err.cause?.code ?? err.message})`;
      return { ok: false, reason, retry: true };
    }
  }
}

/** The `reflex-signature` header for one request. */
export function sign(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
