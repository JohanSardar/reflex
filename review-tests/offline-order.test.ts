import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("offline Sends replay in the order the person pressed Send", () => {
  const dir = mkdtempSync("/tmp/reflex-offline-order-");
  try {
    // Execute the production replay methods, rather than translating their
    // ordering into JS. Only the transport boundary and storage root are supplied.
    const source = readFileSync(new URL("../apps/ipad/Packages/ReflexLink/Sources/ReflexLink/LinkSync.swift", import.meta.url), "utf8");
    function method(name: string) {
      const start = source.indexOf(`    private func ${name}(`);
      assert.notEqual(start, -1);
      let end = source.indexOf("{", start), depth = 1;
      while (depth && ++end < source.length) {
        if (source[end] === "{") depth++;
        if (source[end] === "}") depth--;
      }
      return source.slice(start, end + 1).replace("private func", "func");
    }
    // Two normal valid UUID-derived IDs, deliberately in reverse lexical order.
    // enqueueSend persists these envelopes while the Link is offline.
    const first = "s_f1000000000000000000000000000000";
    const second = "s_11000000000000000000000000000000";
    for (const [id, at, said] of [[first, 1000, "Use the first sketch"], [second, 2000, "Correction: use the second sketch"]] as const) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({
        link: "paired-key", space: "page_test", send: {
          send: id, space: "page_test", by: { person: "p_me", device: "dev_ipad" },
          at, trigger: "voice", viewport: [0, 0, 1024, 768], said,
          words: [{ text: said, start_ms: at - 100, end_ms: at }], strokes: [],
        },
      }));
    }
    const swift = `
import Foundation
final class Session {
    func send(_ h: [String: Any]) {
        if let send = h["send"] as? [String: Any], let id = send["send"] as? String { print(id) }
    }
}
final class Replay {
    static let outboxDir = URL(fileURLWithPath: CommandLine.arguments[1])
    struct Paired { let key: String }
    let paired: Paired? = Paired(key: "paired-key")
    func asset(_ hash: String) -> Data? { nil }
    func sendAsset(_ hash: String, _ bytes: Data, _ s: Session) {}
${method("deliver")}
${method("deliverPending")}
}
Replay().deliverPending(Session())
`;
    const script = join(dir, "replay.swift");
    writeFileSync(script, swift);
    const run = spawnSync("swift", [script, dir], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split("\n"), [first, second], "The receiver must see the original request before its correction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
