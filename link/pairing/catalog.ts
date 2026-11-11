// The signed control catalog: which devices are paired, and which Agents the
// user approved (ARCHITECTURE §6, Identity). It is also the credential store
// for Agents: on its first connection an Agent presents a random credential it
// made itself, and the catalog keeps only its hash, with the user's decision.
// Every later connection with that credential gets the same Agent ID, color
// and decision.
//
// Each record is signed with this device's key. A record whose signature does
// not verify (edited on disk, copied from elsewhere) is ignored.
//
// Self-declared names are labels, never authentication: an Agent is known by
// its credential, a device by its key.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { sha256, signWith, verifyFrom, type DeviceKey } from "./crypto.ts";

export interface Person {
  id: string;
  name: string;
}

export interface PairedDevice {
  device: string;
  key: string; // Ed25519 public key, base64url
  name: string;
  person: Person;
  /** What it said it is when it paired: an iPad, or another Link (which hosts Agents). */
  kind?: "ipad" | "link";
  /** "offer": it scanned a code this Link showed, so the person was at both. "join": this Link scanned its code. */
  via?: "offer" | "join";
  paired_at: number;
  last_seen?: { host: string; port: number; at: number };
}

export type AgentStatus = "pending" | "approved" | "denied" | "revoked";

export interface AgentRecord {
  id: string; // stable Agent ID, e.g. "a_1a2b3c4d5e" (the protocol's agent_id)
  name: string; // what the harness declared
  color: string;
  status: AgentStatus;
  credential_hash: string;
  requested_at: number;
  decided_at: number | null;
  /** Where the person decided: "terminal", or the paired device's ID. */
  decided_by?: string;
}

// The protocol's named colors (common.schema.json#/$defs/color); each renderer picks the shade.
const COLORS = ["violet", "teal", "blue", "orange", "pink", "green"];

export class Catalog {
  #db: DatabaseSync;
  #key: DeviceKey;
  #rejected = 0;

  constructor(db: DatabaseSync, key: DeviceKey) {
    this.#db = db;
    this.#key = key;
  }

  #put(kind: string, id: string, body: unknown): void {
    const text = JSON.stringify(body);
    const sig = signWith(this.#key, `${kind}\n${id}\n${text}`);
    this.#db
      .prepare("INSERT INTO catalog (kind, id, body, sig) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body, sig = excluded.sig")
      .run(kind, id, text, sig);
  }

  #all<T>(kind: string): T[] {
    const rows = this.#db.prepare("SELECT id, body, sig FROM catalog WHERE kind = ? ORDER BY id").all(kind) as {
      id: string;
      body: string;
      sig: string;
    }[];
    const out: T[] = [];
    for (const r of rows) {
      if (verifyFrom(this.#key.publicRaw, `${kind}\n${r.id}\n${r.body}`, r.sig)) out.push(JSON.parse(r.body));
      else this.#rejected++;
    }
    return out;
  }

  /** Records whose signature did not verify since start. */
  get rejected(): number {
    return this.#rejected;
  }

  // Devices

  devices(): PairedDevice[] {
    return this.#all<PairedDevice>("device");
  }

  device(id: string): PairedDevice | undefined {
    return this.devices().find((d) => d.device === id);
  }

  pairDevice(d: PairedDevice): void {
    this.#put("device", d.device, d);
  }

  seen(id: string, host: string, port: number): void {
    const d = this.device(id);
    if (d) this.#put("device", id, { ...d, last_seen: { host, port, at: Date.now() } });
  }

  // Agents

  agents(): AgentRecord[] {
    return this.#all<AgentRecord>("agent");
  }

  agent(id: string): AgentRecord | undefined {
    return this.agents().find((a) => a.id === id);
  }

  /** The Agent this credential belongs to, whatever its status. */
  byCredential(credential: string): AgentRecord | undefined {
    const h = sha256(credential).toString("hex");
    return this.agents().find((a) => a.credential_hash === h);
  }

  /** A first connection: a pending approval record, with a fresh stable ID. */
  request(name: string, credential: string, now = Date.now()): AgentRecord {
    const id = `a_${randomBytes(5).toString("hex")}`;
    const color = COLORS[this.agents().length % COLORS.length];
    const rec: AgentRecord = { id, name, color, status: "pending", credential_hash: sha256(credential).toString("hex"), requested_at: now, decided_at: null };
    this.#put("agent", id, rec);
    return rec;
  }

  decide(id: string, status: "approved" | "denied" | "revoked", by: string, now = Date.now()): AgentRecord {
    const a = this.agent(id);
    if (!a) throw new Error(`No Agent '${id}'. Run \`reflex link agents\` to see them.`);
    const rec = { ...a, status, decided_at: now, decided_by: by };
    this.#put("agent", id, rec);
    return rec;
  }
}
