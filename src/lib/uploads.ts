import 'server-only';

/**
 * VIXART OS — file storage. SERVER ONLY.
 *
 * The `server-only` import above makes importing this from a client component a
 * build error with a clear message, rather than the webpack "node:path is not
 * handled by plugins" wall that it produced once. The browser-safe half of the
 * rules lives in `upload-types.ts`.
 *
 * Bytes live in the `vixart_uploads` Docker volume, never in the database.
 *
 * What keeps this safe, enforced here rather than trusted:
 *  - the stored path is GENERATED (yyyy/mm/<uuid>.<ext>). The name the browser
 *    sent is kept for display only and never touches the filesystem.
 *  - the extension comes from an allowlist, not from the upload.
 *  - every resolved path is confirmed to be inside the uploads root.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_SUMMARY, MAX_UPLOAD_BYTES, extensionFor } from './upload-types';

export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
}

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
  const extension = extensionFor(mime);
  if (!extension) {
    throw new Error(`Files of type "${mime}" are not accepted. ${ALLOWED_SUMMARY}`);
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
 * escapes it. The CHECK constraint already restricts the shape; a path is never
 * joined without this as well.
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
