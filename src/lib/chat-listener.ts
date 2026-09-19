/**
 * One listening connection for the whole process.
 *
 * PostgreSQL delivers `NOTIFY` to a connection, not to a request. A stream per
 * reader would therefore mean a database connection per open browser tab, and
 * on a single core shared with eight other sites that is the version of this
 * feature that makes everything else slow. So there is exactly one: it holds
 * `LISTEN vixart_chat`, and everything else in this file is the fan-out from
 * that one connection to however many readers are attached.
 *
 * Nothing here decides who may read what. The payload is a thread id — see
 * migration 0061 — and the reader answers it by asking for the messages
 * through the ordinary authenticated route.
 *
 * WHAT HAPPENS WHEN IT BREAKS.
 *
 * The connection can drop: a database restart, a network blip, a deploy. It
 * reconnects with backoff, and while it is down `isLive()` is false. That is
 * not cosmetic — the readers ask, and the ones that find the stream down go
 * back to polling at the old interval. A stream that fails quietly, leaving
 * browsers waiting for events that are never coming, would be worse than no
 * stream at all: messages would stop arriving entirely rather than arriving
 * late.
 */

import { Client } from 'pg';

/** What a reader is handed: the thread that changed. */
export type ThreadListener = (threadId: string) => void;

/** Told when announcements start arriving, and when they stop. */
export type LiveListener = (live: boolean) => void;

const CHANNEL = 'vixart_chat';

/** Backoff between reconnection attempts, in milliseconds. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

interface ListenerState {
  client: Client | null;
  /** True only while LISTEN is actually established. */
  live: boolean;
  readers: Set<ThreadListener>;
  watchers: Set<LiveListener>;
  retryMs: number;
  timer: NodeJS.Timeout | null;
  starting: boolean;
}

// Next.js reloads modules in development; without this the old listener keeps
// its connection and a new one is opened beside it on every edit.
const cache = globalThis as unknown as { __vixartChatListener?: ListenerState };

function state(): ListenerState {
  if (!cache.__vixartChatListener) {
    cache.__vixartChatListener = {
      client: null,
      live: false,
      readers: new Set(),
      watchers: new Set(),
      retryMs: RETRY_MIN_MS,
      timer: null,
      starting: false,
    };
  }
  return cache.__vixartChatListener;
}

function announce(s: ListenerState, threadId: string): void {
  for (const reader of s.readers) {
    try {
      reader(threadId);
    } catch {
      // One reader's broken stream is not the other readers' problem.
    }
  }
}

/**
 * Says so when the connection comes up or goes down.
 *
 * Without this the answer to "is the stream carrying?" is only ever read at
 * the moment a reader attaches — which is always BEFORE the connection has
 * finished opening, because opening it is asynchronous. Every reader would be
 * told `degraded` at connect and never told otherwise, so every browser would
 * keep its fast fallback poll forever and the whole exercise would cost more
 * than it saved while appearing to work.
 */
function setLive(s: ListenerState, live: boolean): void {
  if (s.live === live) return;
  s.live = live;
  for (const watcher of s.watchers) {
    try {
      watcher(live);
    } catch {
      // One watcher's broken stream is not the others' problem.
    }
  }
}

function scheduleRetry(s: ListenerState): void {
  if (s.timer || s.readers.size === 0) return;
  const wait = s.retryMs;
  s.retryMs = Math.min(s.retryMs * 2, RETRY_MAX_MS);
  s.timer = setTimeout(() => {
    s.timer = null;
    void connect();
  }, wait);
  // A retry timer must not be the reason the process cannot exit.
  s.timer.unref?.();
}

async function connect(): Promise<void> {
  const s = state();
  if (s.starting || s.live || s.readers.size === 0) return;

  const url = process.env.APP_DATABASE_URL;
  if (!url) return;

  s.starting = true;
  const client = new Client({ connectionString: url });

  const fail = () => {
    setLive(s, false);
    s.starting = false;
    if (s.client === client) s.client = null;
    client.removeAllListeners();
    void client.end().catch(() => {});
    scheduleRetry(s);
  };

  client.on('error', fail);
  client.on('end', fail);
  client.on('notification', (message) => {
    if (message.channel !== CHANNEL || !message.payload) return;
    announce(s, message.payload);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    s.client = client;
    s.starting = false;
    s.retryMs = RETRY_MIN_MS;
    setLive(s, true);
  } catch {
    fail();
  }
}

/**
 * Attach a reader. Returns the function that detaches it.
 *
 * The connection opens on the first reader and closes behind the last, so a
 * server with nobody looking at chat holds nothing open.
 */
export function onThreadChange(reader: ThreadListener): () => void {
  const s = state();
  s.readers.add(reader);
  void connect();

  return () => {
    s.readers.delete(reader);
    if (s.readers.size > 0) return;

    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const client = s.client;
    s.client = null;
    setLive(s, false);
    s.starting = false;
    s.retryMs = RETRY_MIN_MS;
    if (client) {
      client.removeAllListeners();
      void client.end().catch(() => {});
    }
  };
}

/** Whether announcements are currently arriving. Readers ask before trusting it. */
export function isLive(): boolean {
  return state().live;
}

/**
 * Watch the connection come and go. Returns the function that stops watching.
 *
 * This is not diagnostics. A browser told the stream is carrying slows its
 * fallback poll right down, so being told the truth — and being told again
 * when the truth changes — is what stops a dropped listener from turning into
 * a chat application that quietly stops delivering.
 */
export function onLiveChange(watcher: LiveListener): () => void {
  const s = state();
  s.watchers.add(watcher);
  return () => {
    s.watchers.delete(watcher);
  };
}

/** Test seam: deliver an announcement without a database. */
export function announceForTest(threadId: string): void {
  announce(state(), threadId);
}

/** Test seam: how many readers are attached. */
export function readerCountForTest(): number {
  return state().readers.size;
}
