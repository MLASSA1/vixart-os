/**
 * VIXART OS — file storage.
 *
 * Bytes live in the `vixart_uploads` Docker volume, never in the database.
 * A row in `attachment` is metadata; this module owns the file itself.
 *
 * The rules that keep this safe, all enforced here rather than trusted:
 *
 *  - the stored path is GENERATED (yyyy/mm/<uuid>.<ext>). The name the browser
 *    sent is kept for display only and never touches the filesystem, so
 *    "../../etc/passwd" or a 300-character name cannot become a path.
 *  - the extension is taken from an allowlist, not from the upload. An upload
 *    claiming to be .svg or .html would otherwise be served back from our own
 *    origin and could run script against a signed-in session.
 *  - every resolved path is checked to be inside the uploads root before any
 *    read or write.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB, matches the CHECK

/**
 * What may be stored, and the extension each is written with.
 *
 * Deliberately excluded: SVG and HTML (script executes when served from our
 * origin), and every archive and executable type. If a designer needs to share
 * an SVG, it goes in a zip — which is also not on this list, on purpose.
 */
const ALLOWED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
}

export function isAllowedType(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED, mime);
}

export function allowedTypesForInput(): string {
  return Object.keys(ALLOWED).join(',');
}

/** A human list for the hint under the file input. */
export const ALLOWED_SUMMARY =
  'PDF, images, Office documents, MP4/MOV video, MP3/WAV audio. 25 MB maximum.';

export interface StoredFile {
  storedPath: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Writes an uploaded file and returns what to record. Throws with a message
 * meant for the user — the caller shows it as-is.
 */
export async function storeUpload(file: File): Promise<StoredFile> {
  if (file.size === 0) throw new Error('That file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB.`,
    );
  }

  const mime = file.type || 'application/octet-stream';
  const extension = ALLOWED[mime];
  if (!extension) {
    throw new Error(
      `Files of type "${mime}" are not accepted. ${ALLOWED_SUMMARY}`,
    );
  }

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');

  // Generated, not derived from anything the browser sent.
  const relative = `${year}/${month}/${randomUUID()}.${extension}`;
  const absolute = resolveInsideRoot(relative);

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, Buffer.from(await file.arrayBuffer()));

  return { storedPath: relative, sizeBytes: file.size, mimeType: mime };
}

/**
 * Resolves a stored path against the uploads root and refuses anything that
 * escapes it. Belt and braces: the CHECK constraint already restricts the
 * shape, but a path is never joined without this.
 */
export function resolveInsideRoot(relative: string): string {
  const root = path.resolve(uploadsRoot());
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Refused: that path is outside the uploads directory.');
  }
  return resolved;
}

/** Best-effort removal. A missing file is not an error worth surfacing. */
export async function removeStored(relative: string): Promise<void> {
  try {
    await unlink(resolveInsideRoot(relative));
  } catch {
    // Already gone, or never written. The row is what matters.
  }
}

/** 1,4 MB — matching the money formatter's comma decimal. */
export function formatBytes(bytes: number | bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
