// A Send the person presses while a grant is live must reach that grant's Agent,
// even when it arrives before the Agent's first tool call opens the cloud
// session. The Link's own Inbox hands a Send that arrives before any Agent
// opened its Space to the first Agent that does (link/storage/inbox.ts `adopt`,
// and CloudSession.attach's `routed = 0` rows are the same rule).
//
// relay/domain/session.ts: on a grant's first materialization, `#index(false)`
// writes every Send it finds with `routed = 1`, so `attach()` never adopts them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantTo, setup } from "./harness.ts";

test("a Send that arrives while the grant is live, before the Agent's first call, reaches the Agent", async () => {
  const r = await setup("send-before-first-call");
  try {
    const space = "plan";
    await r.space(space);
    const { token } = await grantTo(r, space, "Claude Code");
    // The person presses Send after approving the sign-in, before the client calls anything.
    await r.send(space, "here is the plan");
    const opened = await r.call(token, "open_space", { space });
    assert.equal(opened.isError, false, `open_space failed: ${opened.text}`);
    const waited = await r.call(token, "wait_for_user", { space, timeout_s: 0 });
    assert.equal(waited.isError, false, `wait_for_user failed: ${waited.text}`);
    assert.equal(waited.json?.kind, "send", `the Agent never got the Send the person pressed while its grant was live: ${waited.text}`);
    assert.ok(waited.json?.send, `expected the Send itself, got: ${waited.text}`);
  } finally {
    await r.close();
  }
});
