// node:fs for the Agent layer inside the Worker: the protocol's files, from
// gen/protocol-files.ts (build.ts). Nothing else in the Worker touches a disk.
import files from "../gen/protocol-files.ts";

const key = (p: string | URL): string => {
  const s = typeof p === "string" ? p : p.pathname;
  const i = s.lastIndexOf("/protocol/");
  return i < 0 ? s : s.slice(i + "/protocol/".length).replace(/\/$/, "");
};

const missing = (p: string | URL): Error => Object.assign(new Error(`ENOENT: ${String(p)} is not bundled into the Worker`), { code: "ENOENT" });

export function readFileSync(p: string | URL): string {
  const k = key(p);
  if (!(k in files)) throw missing(p);
  return files[k];
}

export function readdirSync(p: string | URL): string[] {
  const dir = key(p) + "/";
  return Object.keys(files)
    .filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes("/"))
    .map((f) => f.slice(dir.length));
}

export function existsSync(p: string | URL): boolean {
  return key(p) in files;
}

const nope = (): never => {
  throw new Error("no file system in the Worker");
};
export const writeFileSync = nope;
export const appendFileSync = nope;
export const mkdirSync = nope;
export default { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync, mkdirSync };
