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
  // What a browser actually records. MediaRecorder gives WebM/Opus on Chrome
  // and Firefox, Ogg on some Firefox builds, and MP4/AAC on Safari — so all
  // three have to be storable or the microphone button is decorative on
  // somebody's machine.
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

/**
 * The type without its parameters.
 *
 * A recorded blob announces itself as `audio/webm;codecs=opus`, which is a
 * perfectly correct media type and matches nothing in the table above. The
 * codec is not our business — what may be stored is decided by the container.
 */
export function normaliseMime(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

export function isAllowedType(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, normaliseMime(mime));
}

export function extensionFor(mime: string): string | undefined {
  return ALLOWED_TYPES[normaliseMime(mime)];
}

/** Anything that should be played rather than downloaded. */
export function isAudio(mime: string | null | undefined): boolean {
  return normaliseMime(mime ?? '').startsWith('audio/');
}

/** 0:07, 1:42, 12:05 — the way a voice note states its length. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The recorder stops itself here. Longer than this is a file, not a note. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;

/** For the `accept` attribute on the file input. */
export function allowedTypesForInput(): string {
  return Object.keys(ALLOWED_TYPES).join(',');
}

/** A human list for the hint under the file input. */
export const ALLOWED_SUMMARY =
  'PDF, images, Office documents, video and audio. 25 MB maximum.';

/** 1,4 MB — comma decimal, matching the money formatter. */
export function formatBytes(bytes: number | bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
