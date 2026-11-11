// A person can grant the same Space to two cloud clients (two sign-ins approved
// from the Link's terminal: `relay link relay` lists both). Each grant is its
// own live session: relay/domain/session.ts keeps `c_sends` and `c_attached`
// per grant, and relay/domain/log.ts gives each grant its own access token.
//
// relay/domain/log.ts:226 `#sessionFor` keeps one CloudSession for the whole
// log and closes the previous one, so any call from the second grant tears down
// the first: it re-materializes the whole Space on every call, and an Agent
// blocked in wait_for_user there is woken and left reading a freed Space.
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantTo, setup } from "./harness.ts";

test("two grants on one Space each keep their session; one Agent's wait survives the other's call", async () => {
  const r = await setup("two-grants");
  try {
    const space = "plan";
    await r.space(space);
    const a = await grantTo(r, space, "Claude Code");
    const b = await grantTo(r, space, "Codex");
    assert.notEqual(a.grant.gid, b.grant.gid);
    const openA = await r.call(a.token, "open_space", { space });
    assert.equal(openA.isError, false, `open_space (A) failed: ${openA.text}`);

    // A's Agent waits for the person, for up to 20 s, as it does in a real session.
    const waiting = r.call(a.token, "wait_for_user", { space, timeout_s: 20 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Meanwhile the other granted client makes a call of its own.
    const openB = await r.call(b.token, "open_space", { space });
    assert.equal(openB.isError, false, `open_space (B) failed: ${openB.text}`);

    // The person presses Send: it must reach A's waiting Agent.
    await r.send(space, "look at this");
    const waited = await waiting;
    assert.equal(waited.isError, false, `A's wait_for_user broke when the other granted client called: ${waited.text}`);
    assert.equal(waited.json?.kind, "send", `A's waiting Agent did not get the Send: ${waited.text}`);
  } finally {
    await r.close();
  }
});
