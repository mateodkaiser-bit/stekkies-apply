/**
 * Auto-confirm email double-opt-ins that block our submitted applications.
 *
 * VBO listings route through leadflow.rent, which emails
 * "[Actie vereist] Bevestig jouw e-mail" after the bot submits; the lead is NOT
 * forwarded to the agent until that link is clicked. This module scans the inbox
 * for such unread confirmation emails (strictly limited to known senders /
 * subjects), fetches the confirmation link, and marks the email read.
 *
 * Test run:  npx tsx src/confirm-optin.ts
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const CONFIRM_SUBJECT = /bevestig\s+(je|jouw|uw)\s+e-?mail|confirm\s+your\s+e-?mail/i;
const LINK_HINT = /confirm|bevestig|verify|activate|opt-?in/i;
const LINK_BLOCK = /unsubscribe|afmeld|uitschrijv|privacy|mailto:/i;

function client() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing GMAIL_USER / GMAIL_APP_PASSWORD in .env');
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
}

function extractConfirmLinks(html: string): string[] {
  const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  const picked = urls.filter((u) => LINK_HINT.test(u) && !LINK_BLOCK.test(u));
  return [...new Set(picked)];
}

/** Click pending opt-in confirmation links. Returns how many emails were confirmed. */
export async function confirmPendingOptIns(log: (m: string) => void = console.log): Promise<number> {
  const c = client();
  await c.connect();
  let confirmed = 0;
  try {
    await c.mailboxOpen('INBOX');
    // Two narrow searches: known sender, or the exact confirmation subject.
    const uids = new Set<number>();
    // Only recent mail: a confirmation older than a week is stale (and an old
    // unrelated "bevestig" email must never be touched).
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    for (const criteria of [
      { from: 'leadflow.rent', seen: false, since },
      { subject: 'Bevestig', seen: false, since },
    ] as any[]) {
      for (const uid of (await c.search(criteria, { uid: true })) || []) uids.add(uid);
    }
    if (!uids.size) return 0;
    for await (const msg of c.fetch([...uids], { source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source as Buffer);
      const from = parsed.from?.text || '';
      const subject = parsed.subject || '';
      const fromLeadflow = /leadflow\.rent/i.test(from);
      if (!fromLeadflow && !CONFIRM_SUBJECT.test(subject)) continue;
      const html = parsed.html || parsed.textAsHtml || parsed.text || '';
      const links = extractConfirmLinks(html);
      if (!links.length) {
        log(`no confirm link found in "${subject}" (${from})`);
        continue;
      }
      let ok = false;
      for (const link of links.slice(0, 3)) {
        try {
          const res = await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
          log(`clicked ${link.slice(0, 90)} -> HTTP ${res.status}`);
          if (res.ok) { ok = true; break; }
        } catch (e) {
          log(`confirm link failed: ${(e as Error).message.slice(0, 80)}`);
        }
      }
      if (ok) {
        confirmed++;
        await c.messageFlagsAdd(String(msg.uid), ['\\Seen'], { uid: true }).catch(() => {});
      }
    }
  } finally {
    await c.logout().catch(() => {});
  }
  return confirmed;
}

// ── test entrypoint ──
if (import.meta.url === `file://${process.argv[1]}`) {
  confirmPendingOptIns()
    .then((n) => console.log(`\n${n} opt-in email(s) confirmed.`))
    .catch((e) => { console.error('✗', e); process.exit(1); });
}
