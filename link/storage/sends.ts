// Native Sends are immutable snapshots. They are committed with their Inbox index
// before the iPad is acknowledged; retrying an ID never creates another delivery.
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.ts";
import type { Inbox } from "./inbox.ts";

export type Bounds = [number, number, number, number];
export interface InkStroke {
  id: string;
  points: number[][];
  bounds: Bounds;
  color: string;
  width: number;
  at: number;
}
export interface NativeSend {
  send: string;
  space: string;
  by: { person: string; device: string };
  at: number;
  trigger: string;
  viewport: Bounds;
  strokes: InkStroke[];
  /** The page as it was when Send was pressed, for targets around earlier writing. */
  context?: InkStroke[];
  said?: string;
  words?: { text: string; start_ms: number; end_ms?: number }[];
  hints?: { strokes: string[]; text: string; confidence: number }[];
  crops?: { asset: string; bounds: Bounds; strokes?: string[]; kind?: "screen" | "recent_strokes" }[];
}

const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,200}$/.test(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bounds = (v: unknown): v is Bounds =>
  Array.isArray(v) && v.length === 4 && v.every(finite) && v[2] >= 0 && v[3] >= 0;
function ink(v: unknown): v is InkStroke {
  if (!v || typeof v !== "object") return false;
  const s = v as InkStroke;
  return (
    id(s.id) &&
    bounds(s.bounds) &&
    finite(s.at) &&
    finite(s.width) &&
    typeof s.color === "string" &&
    Array.isArray(s.points) &&
    s.points.length > 0 &&
    s.points.length <= 200_000 &&
    s.points.every((p) => Array.isArray(p) && p.length === 4 && p.every(finite))
  );
}

export function nativeSend(raw: unknown, space: unknown, person: string, device: string): NativeSend {
  if (!raw || typeof raw !== "object" || !id(space)) throw new Error("Invalid Send envelope");
  const s = raw as NativeSend;
  if (
    !id(s.send) ||
    s.space !== space ||
    !finite(s.at) ||
    !bounds(s.viewport) ||
    !["button", "voice"].includes(s.trigger) ||
    !Array.isArray(s.strokes) ||
    s.strokes.length > 20_000 ||
    !s.strokes.every(ink) ||
    (s.context !== undefined && (!Array.isArray(s.context) || s.context.length > 20_000 || !s.context.every(ink))) ||
    (s.said !== undefined && (typeof s.said !== "string" || s.said.length > 100_000)) ||
    (s.words !== undefined &&
      (!Array.isArray(s.words) ||
        !s.words.every(
          (w) => typeof w.text === "string" && finite(w.start_ms) && (w.end_ms === undefined || finite(w.end_ms)),
        ))) ||
    (s.hints !== undefined &&
      (!Array.isArray(s.hints) ||
        !s.hints.every(
          (h) => Array.isArray(h.strokes) && h.strokes.every(id) && typeof h.text === "string" && finite(h.confidence),
        ))) ||
    (s.crops !== undefined &&
      (!Array.isArray(s.crops) ||
        !s.crops.every(
          (c) =>
            /^[a-f0-9]{64}$/.test(c.asset) &&
            bounds(c.bounds) &&
            (c.kind === undefined || ["screen", "recent_strokes"].includes(c.kind)) &&
            (c.strokes === undefined || (Array.isArray(c.strokes) && c.strokes.every(id))),
        )))
  ) {
    throw new Error("Invalid native Send");
  }
  // The authenticated session owns attribution, never untrusted envelope fields.
  return { ...s, space, by: { person, device } };
}

export class SendStore {
  readonly db: DatabaseSync;
  readonly inbox: Inbox;
  constructor(db: DatabaseSync, inbox: Inbox) {
    this.db = db;
    this.inbox = inbox;
    db.exec(
      "CREATE TABLE IF NOT EXISTS native_sends (send TEXT PRIMARY KEY, space TEXT NOT NULL, body TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  }
  ingest(send: NativeSend): boolean {
    return tx(this.db, () => {
      const previous = this.get(send.send);
      if (previous) {
        if (previous.by.device !== send.by.device || previous.space !== send.space)
          throw new Error("Send ID belongs to another device or page");
        return false;
      }
      this.db
        .prepare("INSERT INTO spaces (id, kind, created_at) VALUES (?, 'space', ?) ON CONFLICT DO NOTHING")
        .run(send.space, send.at);
      this.db
        .prepare("INSERT INTO native_sends (send, space, body, device, at) VALUES (?, ?, ?, ?, ?)")
        .run(send.send, send.space, JSON.stringify(send), send.by.device, send.at);
      this.inbox.index(send.space, [send.send], `send:${send.by.device}`);
      return true;
    });
  }
  get(send: string): NativeSend | undefined {
    const row = this.db.prepare("SELECT body FROM native_sends WHERE send = ?").get(send) as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  list(space?: string): NativeSend[] {
    return (
      this.db
        .prepare("SELECT body FROM native_sends WHERE (? IS NULL OR space = ?) ORDER BY rowid")
        .all(space ?? null, space ?? null) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
}
