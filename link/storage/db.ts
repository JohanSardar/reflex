// The Link's one SQLite database: journal, checkpoints, Inbox index and the
// signed control catalog. WAL with synchronous=FULL, so a committed
// transaction survives a crash or power loss.
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  space TEXT PRIMARY KEY REFERENCES spaces(id), bytes BLOB NOT NULL, upto INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL REFERENCES spaces(id),
  origin TEXT NOT NULL, bytes BLOB NOT NULL, heads TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_space ON journal(space, seq);
CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, send TEXT NOT NULL,
  arrived_at INTEGER NOT NULL, via TEXT NOT NULL, UNIQUE(space, send)
);
CREATE TABLE IF NOT EXISTS receipts (
  space TEXT NOT NULL, send TEXT NOT NULL, recipient TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reason TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (space, send, recipient)
);
CREATE TABLE IF NOT EXISTS catalog (
  kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY (kind, id)
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Runs `fn` in one write transaction: all of it is durable, or none of it. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
