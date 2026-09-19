'use client';

/**
 * One `EventSource` per tab, however many things are listening.
 *
 * The message pane wants its own thread; the sidebar wants any thread. Opening
 * a stream each would be two connections per tab for one question, so both
 * subscribe here and the stream is opened on the first subscriber and closed
 * behind the last.
 *
 * It is also closed while the tab is hidden. A laptop with nine tabs open is
 * the normal state of a working day, and eight of them holding a connection to
 * a single-core server to hear about messages nobody is looking at is exactly
 * the cost this feature was supposed to remove. Coming back re-opens it, and
 * `onReady` fires, which is what makes the return visible: a reconnect is also
 * an instruction to re-read.
 */

/** What a subscriber is told. */
export interface StreamEvents {
  /** A thread changed. The id, and nothing else — go and ask. */
  onChange: (threadId: string) => void;
  /**
   * The connection is up, or came back up.
   *
   * Both meanings matter. `live` means announcements are arriving and a fast
   * poll is waste. `degraded` means the server is up but the database listener
   * is not, so nothing will be announced and the poll is all there is.
   *
   * Either way it means: whatever happened while you were not connected, you
   * have not seen. Re-read.
   */
  onReady: (mode: 'live' | 'degraded') => void;
  /** The connection dropped. Poll like there is no stream, because there isn't. */
  onDrop: () => void;
}

type Subscriber = Partial<StreamEvents>;

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let watchingVisibility = false;

/**
 * When the connection last carried anything at all.
 *
 * The server sends a ping every 25 seconds as a real event rather than an SSE
 * comment, precisely so this number can exist: `EventSource` hides comments
 * from JavaScript, and a stream that connected and then went silent is
 * indistinguishable from a quiet afternoon.
 *
 * It matters because trusting the stream is what slows the fallback poll to a
 * minute. If anything between here and Agadir buffers the response — an nginx
 * with `proxy_buffering` on, a captive portal, a corporate proxy — the browser
 * would sit waiting on events held in a buffer while asking for them once a
 * minute: slower than the five-second poll this replaced. So the trust is not
 * granted by connecting. It is held only while traffic keeps arriving.
 */
let lastSeen = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

/** Two pings' grace, so one lost packet is not a dropped stream. */
const SILENCE_LIMIT_MS = 70_000;
const WATCHDOG_EVERY_MS = 15_000;

function each(fn: (s: Subscriber) => void): void {
  for (const s of [...subscribers]) {
    try {
      fn(s);
    } catch {
      // One subscriber throwing is not the others' problem.
    }
  }
}

function open(): void {
  if (source || typeof window === 'undefined') return;
  if (document.hidden) return;

  const es = new EventSource('/api/chat/stream');
  source = es;
  lastSeen = Date.now();

  es.addEventListener('change', (event) => {
    lastSeen = Date.now();
    const id = (event as MessageEvent<string>).data;
    if (id) each((s) => s.onChange?.(id));
  });

  es.addEventListener('ready', (event) => {
    lastSeen = Date.now();
    const mode = (event as MessageEvent<string>).data === 'live' ? 'live' : 'degraded';
    each((s) => s.onReady?.(mode));
  });

  es.addEventListener('ping', () => {
    lastSeen = Date.now();
  });

  es.addEventListener('error', () => {
    // `EventSource` reconnects by itself, so this is not a close — it is a
    // gap. Subscribers go back to the fast poll until `ready` arrives again.
    each((s) => s.onDrop?.());
  });

  if (!watchdog) {
    watchdog = setInterval(() => {
      if (!source || lastSeen === 0) return;
      if (Date.now() - lastSeen <= SILENCE_LIMIT_MS) return;
      // Silent for longer than the server can be. Whatever the connection
      // says about itself, nothing is coming through it.
      lastSeen = 0;
      each((s) => s.onDrop?.());
    }, WATCHDOG_EVERY_MS);
  }
}

function close(): void {
  source?.close();
  source = null;
  lastSeen = 0;
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

function onVisibilityChange(): void {
  if (document.hidden) {
    close();
    each((s) => s.onDrop?.());
  } else if (subscribers.size > 0) {
    open();
  }
}

/** Attach. Returns the function that detaches. */
export function subscribeToChat(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);

  if (!watchingVisibility && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    watchingVisibility = true;
  }
  open();

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    close();
    if (watchingVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      watchingVisibility = false;
    }
  };
}

/** Test seam: whether a connection is currently held. */
export function isConnectedForTest(): boolean {
  return source !== null;
}

/** Test seam: pretend the last traffic was this long ago. */
export function ageTrafficForTest(ms: number): void {
  if (lastSeen > 0) lastSeen -= ms;
}
