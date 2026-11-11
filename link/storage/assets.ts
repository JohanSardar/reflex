// Content-addressed asset store: crops, photos, PDFs, files.
//
// An asset's ID is the SHA-256 of its bytes. It is stored as 1 MiB chunks,
// each named by its own hash, plus a manifest. Chunks are written first and
// the manifest last, each with fsync and an atomic rename, so an asset is
// either fully durable or absent: it is durable before anything refers to it.
// Every read checks every chunk and the whole asset against their hashes.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256 } from "../pairing/crypto.ts";

const CHUNK = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

interface Manifest {
  hash: string;
  size: number;
  chunks: string[];
}

export class AssetStore {
  #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(join(root, "chunks"), { recursive: true });
    mkdirSync(join(root, "objects"), { recursive: true });
  }

  #path(kind: "chunks" | "objects", hash: string): string {
    return join(this.#root, kind, hash.slice(0, 2), hash);
  }

  #writeDurable(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }

  /** Stores bytes and returns their hash. Storing the same bytes twice is a no-op. */
  put(bytes: Uint8Array): string {
    const hash = sha256(bytes).toString("hex");
    if (this.has(hash)) return hash;
    const chunks: string[] = [];
    let off = 0;
    do {
      const part = bytes.subarray(off, off + CHUNK);
      const h = sha256(part).toString("hex");
      if (!existsSync(this.#path("chunks", h))) this.#writeDurable(this.#path("chunks", h), part);
      chunks.push(h);
      off += CHUNK;
    } while (off < bytes.length);
    const m: Manifest = { hash, size: bytes.length, chunks };
    this.#writeDurable(this.#path("objects", hash), Buffer.from(JSON.stringify(m)));
    return hash;
  }

  has(hash: string): boolean {
    return HASH.test(hash) && existsSync(this.#path("objects", hash));
  }

  /** The asset's bytes, verified. Throws if anything is missing or corrupt. */
  get(hash: string): Buffer {
    if (!this.has(hash)) throw new Error(`No asset ${hash}.`);
    const m = JSON.parse(readFileSync(this.#path("objects", hash), "utf8")) as Manifest;
    const parts = m.chunks.map((h) => {
      const b = readFileSync(this.#path("chunks", h));
      if (sha256(b).toString("hex") !== h) throw new Error(`Asset ${hash}: chunk ${h} is corrupt.`);
      return b;
    });
    const all = Buffer.concat(parts);
    if (all.length !== m.size || sha256(all).toString("hex") !== hash) throw new Error(`Asset ${hash} is corrupt.`);
    return all;
  }

  /** Accepts bytes from a peer only if they match the hash they were asked for. */
  putVerified(hash: string, bytes: Uint8Array): boolean {
    if (sha256(bytes).toString("hex") !== hash) return false;
    this.put(bytes);
    return true;
  }

  list(): string[] {
    const out: string[] = [];
    const objects = join(this.#root, "objects");
    for (const d of safeReaddir(objects)) for (const f of safeReaddir(join(objects, d))) if (HASH.test(f)) out.push(f);
    return out.sort();
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
