import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { isLive, onLiveChange, onThreadChange } from '@/lib/chat-listener';

/**
 * The open line. One per browser tab, carrying thread ids and nothing else.
 *
 * WHY THIS SENDS NO MESSAGES.
 *
 * It would be an obvious saving to put the message on the wire and let the
 * browser draw it. It is not worth it. The announcement arrives on a shared
 * connection with no identity (see `chat-listener.ts`), so the moment content
 * travels this way, whether the right person receives it depends on the
 * routing in this file being correct — a rule that would then exist here as
 * well as in `thread_select`, free to disagree with it.
 *
 * Instead this says only "thread X changed", and the browser fetches through
 * the route it already uses, under its own identity. The stream removes the
 * waiting. It does not become a second way in.
 *
 * WHICH IDS REACH WHOM.
 *
 * Even a bare id is worth withholding: told about a thread on a client they
 * are not on, someone learns that client is being discussed and how often. So
 * the connection is filtered against the threads its owner can actually open,
 * read at connect through the ordinary policies.
 *
 * WHY IT HANGS UP ON ITSELF.
 *
 * That set is read once, and a tab can stay open for days — so a channel
 * created this afternoon would never reach a browser opened this morning. The
 * fix is not a timer refreshing it in the background: `withUser` needs the
 * request that authenticated it, and a variant that took an identity as an
 * argument would be a way to claim one. So the stream closes itself every
 * quarter of an hour and lets `EventSource` reconnect, which re-enters this
 * function through the front door — full authentication, fresh visibility.
 * One request per tab per fifteen minutes buys the refresh, and the browser
 * re-reads the thread on every connect, so the seconds in between lose nothing.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** How long one connection lives before it recycles for a fresh look. */
const CONNECTION_LIFETIME_MS = 15 * 60_000;

/** Under nginx's `proxy_read_timeout`, and under most intermediaries' idle cut. */
const KEEPALIVE_MS = 25_000;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return new NextResponse('Not found', { status: 404 });

  let visible: Set<string>;
  try {
    const rows = await withUser(async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`SELECT id FROM thread`);
      return result.rows;
    });
    visible = new Set(rows.map((r) => String(r.id)));
  } catch {
    // No stream rather than a stream that announces nothing: the browser is
    // told, and keeps polling at the interval it would have used anyway.
    return new NextResponse('Unavailable', { status: 503 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const detachers: Array<() => void> = [];
      const timers: NodeJS.Timeout[] = [];

      const close = () => {
        if (closed) return;
        closed = true;
        for (const d of detachers) d();
        for (const t of timers) clearTimeout(t);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The reader went away between the check and the write.
          close();
        }
      };

      // `retry` is the browser's own reconnection delay: soon enough to be
      // unnoticed, long enough that a restarting server is not met by every
      // tab at once.
      send('retry: 3000\n\n');
      const ready = (live: boolean) =>
        send(`event: ready\ndata: ${live ? 'live' : 'degraded'}\n\n`);

      // Said out loud so the browser knows whether to leave its fallback poll
      // at the slow interval or hurry back to the fast one.
      //
      // Sent now AND on every change, because attaching a reader only STARTS
      // the connection — it is never up yet at this line. A single answer here
      // would be 'degraded' every time, for every browser, forever.
      ready(isLive());
      detachers.push(onLiveChange(ready));

      detachers.push(
        onThreadChange((threadId) => {
          if (!visible.has(threadId)) return;
          send(`event: change\ndata: ${threadId}\n\n`);
        }),
      );

      const keepalive = setInterval(() => {
        // A comment. It keeps nginx and every proxy between here and Agadir
        // from deciding a silent connection is a dead one.
        send(': ping\n\n');
        // Belt and braces behind `onLiveChange`: a browser that missed the
        // transition is told again within half a minute.
        if (!isLive()) ready(false);
      }, KEEPALIVE_MS);
      keepalive.unref?.();
      timers.push(keepalive);

      const lifetime = setTimeout(close, CONNECTION_LIFETIME_MS);
      lifetime.unref?.();
      timers.push(lifetime);

      request.signal.addEventListener('abort', close);
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx honours this even without `proxy_buffering off` in the vhost —
      // belt and braces, because a buffered event stream looks exactly like a
      // broken one, and that symptom is the bug this is here to fix.
      'X-Accel-Buffering': 'no',
    },
  });
}
