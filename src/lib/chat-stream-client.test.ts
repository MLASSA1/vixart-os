import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One connection per tab, and a fallback that comes back when it goes.
 *
 * The delivery this replaces was a poll: crude, and impossible to break
 * quietly — if the server was there, the message arrived. A stream is the
 * opposite. It works perfectly or it stops, and when it stops it looks exactly
 * like a channel where nobody has said anything.
 *
 * So the behaviour under test is not really "events arrive". It is what
 * happens when they stop: subscribers must be TOLD, so they can go back to
 * asking, and they must re-read on every connect, because a reconnect means a
 * gap and a gap means something was said while nobody was listening.
 */

interface FakeSource {
  url: string;
  closed: boolean;
  listeners: Map<string, Array<(e: unknown) => void>>;
  emit: (type: string, data?: string) => void;
}

const opened: FakeSource[] = [];
let hidden = false;
const visibilityHandlers: Array<() => void> = [];

function installFakes() {
  opened.length = 0;
  hidden = false;
  visibilityHandlers.length = 0;

  class FakeEventSource {
    url: string;
    closed = false;
    listeners = new Map<string, Array<(e: unknown) => void>>();

    constructor(url: string) {
      this.url = url;
      opened.push(this as unknown as FakeSource);
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    close() {
      this.closed = true;
    }
    emit(type: string, data?: string) {
      for (const fn of this.listeners.get(type) ?? []) fn({ data });
    }
  }

  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') visibilityHandlers.push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type !== 'visibilitychange') return;
      const i = visibilityHandlers.indexOf(fn);
      if (i >= 0) visibilityHandlers.splice(i, 1);
    },
  });
}

function setHidden(value: boolean) {
  hidden = value;
  for (const fn of [...visibilityHandlers]) fn();
}

const live = () => opened.filter((s) => !s.closed);

async function load() {
  vi.resetModules();
  return import('./chat-stream-client');
}

describe('the chat stream, in the browser', () => {
  beforeEach(installFakes);
  afterEach(() => vi.unstubAllGlobals());

  it('opens one connection however many things are listening', async () => {
    const { subscribeToChat } = await load();

    // The message pane and the sidebar both want to know. Two connections per
    // tab for one question is the cost this feature was meant to remove.
    const a = subscribeToChat({ onChange: () => {} });
    const b = subscribeToChat({ onChange: () => {} });

    expect(opened).toHaveLength(1);
    a();
    expect(live()).toHaveLength(1); // still one listener left
    b();
    expect(live()).toHaveLength(0); // closed behind the last
  });

  it('gives every subscriber the thread that changed', async () => {
    const { subscribeToChat } = await load();
    const pane: string[] = [];
    const sidebar: string[] = [];
    subscribeToChat({ onChange: (id) => pane.push(id) });
    subscribeToChat({ onChange: (id) => sidebar.push(id) });

    opened[0]!.emit('change', 'thread-7');

    expect(pane).toEqual(['thread-7']);
    expect(sidebar).toEqual(['thread-7']);
  });

  it('one subscriber throwing does not rob the others', async () => {
    const { subscribeToChat } = await load();
    const seen: string[] = [];
    subscribeToChat({ onChange: () => { throw new Error('boom'); } });
    subscribeToChat({ onChange: (id) => seen.push(id) });

    opened[0]!.emit('change', 'thread-9');
    expect(seen).toEqual(['thread-9']);
  });

  it('tells subscribers when the stream drops, so they can go back to asking', async () => {
    const { subscribeToChat } = await load();
    let dropped = 0;
    subscribeToChat({ onDrop: () => (dropped += 1) });

    opened[0]!.emit('error');
    expect(dropped).toBe(1);
  });

  it('treats every connect as a gap to be read, not just the first', async () => {
    const { subscribeToChat } = await load();
    const readings: string[] = [];
    subscribeToChat({ onReady: (mode) => readings.push(mode) });

    // A reconnect after a drop is precisely when something was missed.
    opened[0]!.emit('ready', 'live');
    opened[0]!.emit('error');
    opened[0]!.emit('ready', 'live');

    expect(readings).toEqual(['live', 'live']);
  });

  it('distinguishes a stream that is up from one that is carrying', async () => {
    const { subscribeToChat } = await load();
    const modes: string[] = [];
    subscribeToChat({ onReady: (mode) => modes.push(mode) });

    // The server is answering, but the database listener behind it is not.
    // Saying 'live' here would put the fallback poll to sleep in exactly the
    // case where the fallback poll is the only delivery there is.
    opened[0]!.emit('ready', 'degraded');
    expect(modes).toEqual(['degraded']);
  });

  it('stops trusting a stream that connected and then went quiet', async () => {
    // THE CASE THIS EXISTS FOR. An nginx with proxy_buffering on, a captive
    // portal, a corporate proxy: the connection is open, `ready` may even have
    // arrived, and nothing is coming through. A browser that trusted the
    // connection would have slowed its fallback poll to a minute while waiting
    // on events sitting in somebody's buffer — slower than the five-second
    // poll this replaced, and silently.
    vi.useFakeTimers();
    try {
      const { subscribeToChat, ageTrafficForTest } = await load();
      let dropped = 0;
      subscribeToChat({ onDrop: () => (dropped += 1) });

      opened[0]!.emit('ready', 'live');
      vi.advanceTimersByTime(15_000);
      expect(dropped).toBe(0); // 15s of quiet is a quiet afternoon

      // Longer than the server can be silent: it pings every 25 seconds.
      ageTrafficForTest(80_000);
      vi.advanceTimersByTime(15_000);
      expect(dropped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a ping is traffic, so a quiet channel is not a dropped stream', async () => {
    vi.useFakeTimers();
    try {
      const { subscribeToChat } = await load();
      let dropped = 0;
      subscribeToChat({ onDrop: () => (dropped += 1) });

      // Nobody says anything for five minutes. The server pings throughout.
      for (let i = 0; i < 12; i += 1) {
        vi.advanceTimersByTime(25_000);
        opened[0]!.emit('ping', String(i));
      }
      expect(dropped).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds nothing open while the tab is hidden', async () => {
    const { subscribeToChat, isConnectedForTest } = await load();
    let dropped = 0;
    subscribeToChat({ onDrop: () => (dropped += 1) });
    expect(isConnectedForTest()).toBe(true);

    // Nine tabs open since Monday, all of them holding a connection to a
    // single core to hear about messages nobody is reading.
    setHidden(true);
    expect(isConnectedForTest()).toBe(false);
    // And told, so the hidden tab is not left believing it is being fed.
    expect(dropped).toBe(1);

    setHidden(false);
    expect(isConnectedForTest()).toBe(true);
  });

  it('does not open one at all if the tab starts hidden', async () => {
    const { subscribeToChat } = await load();
    hidden = true;
    subscribeToChat({ onChange: () => {} });
    expect(opened).toHaveLength(0);
  });
});
