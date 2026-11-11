import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { clientReplyMail } = await import('./client-reply-mail');

describe('the email that tells a client we replied', () => {
  const base = { full_name: 'Sara Idrissi', company_name: 'Riad Atlas', author_name: 'Amin', preview: 'First cut is ready.', replies: 1 };

  it('names who replied, quotes one line, and links to the conversation', () => {
    const m = clientReplyMail(base, 'https://client.example/portal/support');
    expect(m.subject).toBe('Amin replied to you — VIXART');
    expect(m.text).toContain('Hello Sara,');
    expect(m.text).toContain('“First cut is ready.”');
    expect(m.text).toContain('https://client.example/portal/support');
    expect(m.text).toContain('turn these emails off');
  });

  it('says how many when replies came in a burst', () => {
    expect(clientReplyMail({ ...base, replies: 3 }).subject).toBe('3 new messages from VIXART');
  });

  it('escapes what it quotes in the HTML', () => {
    const m = clientReplyMail({ ...base, preview: '<b>hi</b> & "you"' });
    expect(m.html).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; &quot;you&quot;');
    expect(m.html).not.toContain('<b>hi</b>');
  });
});
