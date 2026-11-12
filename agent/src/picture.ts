// Pictures an Agent places from a file on the Link's computer (an image
// Element's `src`): a scanned page, a photo, a diagram. Like a 3D model, the
// file is read once and stored as an asset, so every device draws it without
// reaching this computer's files. PNG and JPEG are stored as they are; other
// formats (HEIC, WebP, GIF, TIFF) and the first page of a PDF are turned into
// a PNG with macOS's own tools.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelError } from "./model.ts";

const run = promisify(execFile);
/** The largest picture file Reflex reads. */
export const MAX_PICTURE_BYTES = 40 * 1024 * 1024;
/** A PDF page is drawn this many pixels on its long side: enough to read a scanned page. */
const PDF_PX = 2000;

export type Picture = { bytes: Buffer; w: number; h: number; name: string };

const isPng = (b: Buffer) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47;
const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
const isPdf = (b: Buffer) => b.length > 5 && b.toString("latin1", 0, 5) === "%PDF-";

/** Width and height of a PNG or JPEG, from its header. */
export function pictureSize(b: Buffer): { w: number; h: number } | undefined {
  if (isPng(b)) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (!isJpeg(b)) return undefined;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    // Start-of-frame markers (not DHT, JPG or DAC) carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return undefined;
}

/** Reads a picture from a file path (`/…`, `~/…` or `file:///…`) and returns PNG or JPEG bytes with their size. */
export async function importPicture(ref: string): Promise<Picture> {
  const file = ref.startsWith("file://") ? fileURLToPath(ref) : ref.replace(/^~(?=\/)/, process.env.HOME ?? "~");
  if (!path.isAbsolute(file)) throw new ModelError(`'${ref}' is not an absolute path.`, "Pass the picture's full path, such as /Users/me/scans/quiz.pdf.");
  const info = await stat(file).catch((e: Error) => {
    throw new ModelError(`Couldn't read ${file}: ${e.message}.`, "Check the path.");
  });
  if (!info.isFile()) throw new ModelError(`${file} is not a file.`, "Pass the path of one picture or PDF.");
  if (info.size > MAX_PICTURE_BYTES) throw new ModelError(`${file} is over ${MAX_PICTURE_BYTES / 1e6} MB.`, "Use a smaller picture.");
  const name = path.basename(file);
  const bytes = await readFile(file);
  const size = pictureSize(bytes);
  if (size) return { bytes, ...size, name };
  if (process.platform !== "darwin") throw new ModelError(`${name} is not a PNG or JPEG.`, "Convert it to PNG or JPEG first.");
  const dir = await mkdtemp(path.join(tmpdir(), "reflex-picture-"));
  try {
    if (isPdf(bytes)) {
      // Quick Look draws the first page at a readable size.
      await run("qlmanage", ["-t", "-s", String(PDF_PX), "-o", dir, file], { timeout: 30_000 });
    } else {
      await run("sips", ["-s", "format", "png", file, "--out", path.join(dir, "picture.png")], { timeout: 30_000 });
    }
    const out = (await readdir(dir)).find((f) => f.endsWith(".png"));
    const png = out ? await readFile(path.join(dir, out)) : undefined;
    const s = png && pictureSize(png);
    if (!png || !s) throw new Error("no picture came out");
    return { bytes: png, ...s, name };
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(`Couldn't read ${name} as a picture or PDF.`, "Export it as PNG, JPEG or PDF.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
