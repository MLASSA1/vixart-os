/**
 * VIXART OS — upload rules shared by the browser and the server.
 *
 * Deliberately free of Node imports. `uploads.ts` does the filesystem work and
 * cannot be reached from a client component; this half can, so the file input
 * and the size formatter live here.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB, matches the CHECK

/**
 * What may be stored, and the extension each is written with.
 *
 * Deliberately excluded: SVG and HTML (script executes when served from our
 * origin, against a signed-in session), and every archive and executable type.
 */
export const ALLOWED_TYPES: Record<string, string> = {
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

export function isAllowedType(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, mime);
}

export function extensionFor(mime: string): string | undefined {
  return ALLOWED_TYPES[mime];
}

/** For the `accept` attribute on the file input. */
export function allowedTypesForInput(): string {
  return Object.keys(ALLOWED_TYPES).join(',');
}

/** A human list for the hint under the file input. */
export const ALLOWED_SUMMARY =
  'PDF, images, Office documents, MP4/MOV video, MP3/WAV audio. 25 MB maximum.';

/** 1,4 MB — comma decimal, matching the money formatter. */
export function formatBytes(bytes: number | bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
