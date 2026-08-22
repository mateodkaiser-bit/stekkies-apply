/**
 * Gmail inbox reader (IMAP) — the cheap "sensor" that spots Stekkies match emails.
 *
 * Uses the "Homemaker" app password (GMAIL_APP_PASSWORD) over IMAP — no OAuth,
 * no browser. Returns parsed matches; the orchestrator then opens only real ones
 * in a cloud browser.
 *
 * Test run:  npx tsx src/watch-inbox.ts
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { extractMatchLinks, isStekkiesMatchEmail, parseListingCards, parseListingFields, type ListingFields, type MatchLink } from './parse-email.ts';

export interface ParsedMatchEmail {
  emailUid: number;
  subject: string;
  date: Date | null;
  links: MatchLink[];
  /** Whole-email fields. Kept for callers that only want a rough summary. */
  fields: ReturnType<typeof parseListingFields>;
  /**
   * Per-listing fields keyed by match id — address, neighbourhood, price,
   * bedrooms, surface. Prefer this over `fields`: an email can carry several
   * listings, and `fields` gives every one of them the FIRST card's numbers.
   */
  cards: Map<string, ListingFields>;
}

function client() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing GMAIL_USER / GMAIL_APP_PASSWORD in .env');
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
}

/**
 * Fetch recent Stekkies match emails and parse them.
 * @param limit  how many most-recent Stekkies emails to return
 * @param onlyUnseen  restrict to unread mail (what the live watcher will use)
 */
export async function fetchStekkiesMatches(limit = 5, onlyUnseen = false): Promise<ParsedMatchEmail[]> {
  const c = client();
  await c.connect();
  const out: ParsedMatchEmail[] = [];
  try {
    await c.mailboxOpen('INBOX');
    const criteria: any = { from: 'help@stekkies.com' };
    if (onlyUnseen) criteria.seen = false;
    const uids = (await c.search(criteria, { uid: true })) || [];
    const pick = uids.slice(-limit);
    for await (const msg of c.fetch(pick, { source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source as Buffer);
      const subject = parsed.subject || '';
      const from = parsed.from?.text || '';
      if (!isStekkiesMatchEmail(from, subject)) continue;
      const html = parsed.html || parsed.textAsHtml || parsed.text || '';
      const text = parsed.text || '';
      out.push({
        emailUid: msg.uid,
        subject,
        date: parsed.date ?? null,
        links: extractMatchLinks(html),
        fields: parseListingFields(subject, text || html),
        cards: parseListingCards(subject, text || html),
      });
    }
  } finally {
    await c.logout();
  }
  return out;
}

// ── test entrypoint ──
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchStekkiesMatches(5)
    .then((emails) => {
      console.log(`✅ Connected to Gmail. Found ${emails.length} Stekkies match email(s).\n`);
      for (const e of emails) {
        console.log('────────────────────────────────────────');
        console.log('Subject :', e.subject);
        console.log('Date    :', e.date?.toISOString());
        console.log('Fields  :', JSON.stringify(e.fields));
        console.log(`Matches : ${e.links.length}`);
        for (const l of e.links) console.log('   • matchId', l.matchId, '→', l.redirectUrl.split('?')[0]);
      }
    })
    .catch((err) => { console.error('✗', err); process.exit(1); });
}
