/**
 * Writes images (page screenshots, tool screenshots) to
 * `<projectDir>/.devtailor/images/` so Claude Code can open them with its Read
 * tool. File names are built only from controlled characters.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type SaveImageResult =
  | { ok: true; path: string; mimeType: string; bytes: number; base64: string }
  | { ok: false; reason: string };

export function imagesDir(projectDir: string): string {
  return join(resolve(projectDir), '.devtailor', 'images');
}

/** Accepts `data:image/...;base64,...` or bare base64 (assumed PNG). */
export function parseImageInput(input: string): { mimeType: string; base64: string } | null {
  if (typeof input !== 'string' || !input) return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(input);
  if (match) return { mimeType: match[1].toLowerCase(), base64: match[2] };
  if (/^[A-Za-z0-9+/=\s]+$/.test(input)) return { mimeType: 'image/png', base64: input };
  return null;
}

/** Only `[A-Za-z0-9_-]` survives, so the result can never traverse directories. */
export function safeFileBase(name: string): string {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'image';
}

export async function saveImage(projectDir: string, baseName: string, input: string): Promise<SaveImageResult> {
  const parsed = parseImageInput(input);
  if (!parsed) return { ok: false, reason: 'not a base64 image' };
  const ext = EXT_BY_MIME[parsed.mimeType];
  if (!ext) return { ok: false, reason: `unsupported image type ${parsed.mimeType}` };
  const base64 = parsed.base64.replace(/\s+/g, '');
  const estimated = Math.floor((base64.length * 3) / 4);
  if (estimated > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit` };
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return { ok: false, reason: 'empty image' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit` };
  }
  const dir = imagesDir(projectDir);
  const file = resolve(dir, `${safeFileBase(baseName)}.${ext}`);
  if (!file.startsWith(dir + sep)) return { ok: false, reason: 'invalid file name' };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, buffer);
  } catch (err: any) {
    return { ok: false, reason: `write failed: ${err?.message || err}` };
  }
  return { ok: true, path: file, mimeType: parsed.mimeType, bytes: buffer.length, base64 };
}
