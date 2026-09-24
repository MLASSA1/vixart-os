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

export function isImage(mime: string | null | undefined): boolean {
  return normaliseMime(mime ?? '').startsWith('image/');
}

export function isVideo(mime: string | null | undefined): boolean {
  return normaliseMime(mime ?? '').startsWith('video/');
}

/**
 * Served to be LOOKED AT, or served to be SAVED.
 *
 * Every attachment went out as `Content-Disposition: attachment`, which is
 * what a browser obeys by putting the bytes in the downloads folder and
 * nothing on the screen. For a spreadsheet that is exactly right. For a
 * photograph somebody just posted in a conversation it is the whole complaint:
 * you send a picture and the person you sent it to has to go and find it in
 * Finder to see what you said.
 *
 * So: a short list of types a browser renders and cannot be tricked into
 * executing. NOT a general "is it safe" test — SVG and HTML never reach this
 * function because `ALLOWED_TYPES` refuses to store them at all, and if that
 * ever changes this list must not quietly inherit the change. Named one by
 * one for that reason.
 *
 * The response keeps `default-src 'none'; sandbox` and `nosniff` either way,
 * so even an inline document is opened with no origin, no script and no
 * ability to be re-interpreted as something else.
 */
const SHOWN_INLINE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'video/mp4', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac',
  'application/pdf',
  'text/plain', 'text/csv',
]);

export function servedInline(mime: string | null | undefined): boolean {
  return SHOWN_INLINE.has(normaliseMime(mime ?? ''));
}

/**
 * What an iPhone produces that a browser other than Safari cannot decode.
 *
 * HEIC photographs and HEVC video inside a .mov are what an iPhone records on
 * its default "High Efficiency" setting. They upload fine, they are stored
 * fine, and Chrome, Brave and Firefox then show a broken image or a black
 * rectangle — which reads as "this app lost my photo" rather than "your phone
 * chose a format this browser never supported".
 *
 * There is no transcoder here to fix it, so the interface says so instead: the
 * element is given a chance to fail and what replaces it explains itself and
 * offers the file. `.mov` is a container that MAY hold H.264, which does play,
 * so video is judged by whether it actually failed rather than by its type —
 * this is only used for the still image case, where HEIC never works.
 */
export function needsSafari(mime: string | null | undefined): boolean {
  return normaliseMime(mime ?? '') === 'image/heic';
}

/**
 * Which of four things an attachment is, for whoever has to draw it.
 *
 * There are two places that draw one — the team's chat and the client's
 * support conversation — and they look nothing alike: one is warm paper and
 * the other is the company's black. What they must NOT differ on is what
 * counts as a photograph, so the decision lives here and only the appearance
 * lives in each component. Two copies of this switch is how a client ends up
 * downloading a picture the team can see.
 */
export type AttachmentShape = 'audio' | 'image' | 'video' | 'file';

export function attachmentShape(mime: string | null | undefined): AttachmentShape {
  if (isAudio(mime)) return 'audio';
  // HEIC is an image that no browser but Safari will draw, so it is handed
  // over as a file with an explanation rather than as a broken picture.
  if (isImage(mime)) return needsSafari(mime) ? 'file' : 'image';
  if (isVideo(mime)) return 'video';
  return 'file';
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
