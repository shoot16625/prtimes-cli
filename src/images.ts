import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { CliError } from "./client.ts";

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface ImageFile {
  path: string;
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export function isLocalImageRef(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//");
}

export function resolveImagePath(src: string, baseDir: string): string {
  const clean = decodeURIComponent(src.replace(/^<|>$/g, ""));
  return isAbsolute(clean) ? clean : resolve(baseDir, clean);
}

/** Detect PNG / JPEG / GIF from magic bytes (PR TIMES accepts these). */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

export async function readImage(path: string): Promise<ImageFile> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new CliError("INVALID_INPUT", `Image not found: ${path}`);
  }
  if (size > IMAGE_MAX_BYTES) throw new CliError("INVALID_INPUT", `Image is larger than 10 MB: ${path}`);
  const bytes = new Uint8Array(await readFile(path));
  const mime = sniffMime(bytes);
  if (!mime) throw new CliError("INVALID_INPUT", `Unsupported image format (use PNG, JPEG or GIF): ${path}`);
  return { path, name: basename(path), mime, bytes };
}

/** PR TIMES stores the pixel size in the S3 file name: `...-1200x630.png`. */
export function sizeFromS3Name(name: string): { width?: number; height?: number } {
  const m = name.match(/-(\d+)x(\d+)\.[a-z]+$/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}
