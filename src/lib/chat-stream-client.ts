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

  es.addEventListener('change', (event) => {
    const id = (event as MessageEvent<string>).data;
    if (id) each((s) => s.onChange?.(id));
  });

  es.addEventListener('ready', (event) => {
    const mode = (event as MessageEvent<string>).data === 'live' ? 'live' : 'degraded';
    each((s) => s.onReady?.(mode));
  });

  es.addEventListener('error', () => {
    // `EventSource` reconnects by itself, so this is not a close — it is a
    // gap. Subscribers go back to the fast poll until `ready` arrives again.
    each((s) => s.onDrop?.());
  });
}

function close(): void {
  source?.close();
  source = null;
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
