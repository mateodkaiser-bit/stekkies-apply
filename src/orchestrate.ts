/**
 * Orchestrator: the glue. Poll Gmail for Stekkies matches, dedupe (by match id
 * AND by address, so manually-applied listings are skipped), open each match to
 * find its source, route it (Pararius -> auto-apply; paywalled/unknown ->
 * needs_manual), and email a summary.
 *
 * DRY-RUN by default. Flags:  --live   --limit=N
 *
 * Run:  npx tsx src/orchestrate.ts --limit=2
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { fetchStekkiesMatches } from './watch-inbox.ts';
import { readMatchPage } from './read-match.ts';
import { applyPararius } from './apply-pararius.ts';
import { applyVbo } from './apply-vbo.ts';
import { applyForm } from './apply-form.ts';
import { applyGeneric } from './apply-generic.ts';
import { sendApplicationEmail } from './send-email.ts';
import { confirmPendingOptIns } from './confirm-optin.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
const SEEN = join(__dirname, '..', 'seen.json');

const LIVE = process.argv.includes('--live');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 3);
const MAX_PER_DAY = Number((process.argv.find((a) => a.startsWith('--maxday=')) || '').split('=')[1] || 12);

// Surface applier diagnostics: print the step log (visible in the GitHub run
// log) and append the Browserbase session replay URL to the result line so
// every application is auditable from the summary email / results.log.
const finishLine = (line: string, r: any): string => {
  for (const l of r?.log || []) console.log('    ·', l);
  const rp = (r?.log || []).filter((l: string) => typeof l === 'string' && l.startsWith('replay:')).pop();
  return rp ? `${line} | ${rp.replace('replay: ', '')}` : line;
};

const normAddr = (a?: string | null) => (a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normSite = (s?: string | null) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
// Sites known to require an account/login. Short-circuited with a clean reason
// (no agent run wasted). Once you register + we save a Context, remove the entry.
const GATED: Record<string, string> = {
  schep: 'free MyProperty account required (register once to enable auto-apply)',
  myproperty: 'free MyProperty account required (register once to enable auto-apply)',
  // Observed in the July logs to always demand "account or login required to
  // submit". Short-circuit so we do not spend a Browserbase session just to hit
  // the wall. Remove an entry once you register there and we save a Context.
  vbtverhuurmakelaars: 'account/login required (register once to enable auto-apply)',
  wonennu: 'account/login required (register once to enable auto-apply)',
};
type Seen = { matchIds: string[]; addresses: string[]; appliedToday?: { date: string; count: number }; retries?: Record<string, number> };
// Failures where the form was never reached/submitted, so retrying on a later
// run is safe (no double-apply risk) and often succeeds (proxy IP roulette).
const TRANSIENT = /blocked the load|time-?d? ?out|timeout|net::|ECONN|ETIMEDOUT|Target closed|browser has been closed/i;
const MAX_RETRIES = 3;
const loadSeen = (): Seen => (existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : { matchIds: [], addresses: [] });
const saveSeen = (s: Seen) => writeFileSync(SEEN, JSON.stringify(s, null, 2));

async function openMatchPage(matchUrl: string) {
  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contexts.stekkies, persist: false }, verified: true, os: 'mac' },
    proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
    timeout: 120,
  } as any);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    return await readMatchPage(page, matchUrl);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const seen = loadSeen();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  if (!seen.appliedToday || seen.appliedToday.date !== today) seen.appliedToday = { date: today, count: 0 };
  const emails = await fetchStekkiesMatches(30); // fetch enough to catch up on overnight backlog

  const matches: any[] = [];
  const s = new Set<string>();
  for (const e of emails) for (const l of e.links) {
    if (s.has(l.matchId)) continue;
    s.add(l.matchId);
    matches.push({ ...l, fields: e.fields });
  }
  const fresh = matches.filter((m) => !seen.matchIds.includes(m.matchId)).slice(0, LIMIT);
  console.log(`${matches.length} matches found, ${fresh.length} fresh to process (limit ${LIMIT}). Mode: ${LIVE ? 'LIVE' : 'DRY-RUN'}\n`);

  const summary: string[] = [];
  // Structured record per listing so the notification email can lead with the
  // street address and the listing link (not just the terse results.log line).
  type Entry = { status: string; address: string | null; url: string; site: string; price: string; raw: string };
  const entries: Entry[] = [];
  for (const mt of fresh) {
    let line = '';
    let transient = false;
    let info: any = null;
    try {
      info = await openMatchPage(mt.redirectUrl);
      const price = mt.fields.priceEur ? `EUR ${mt.fields.priceEur}` : '';
      const label = `${info.address || mt.matchId} (${info.sourceSite || '?'}, ${price})`;

      if (info.address && seen.addresses.includes(normAddr(info.address))) {
        line = `SKIPPED: ${label} | already applied to this address`;
      } else if (info.paidToApply) {
        line = `NEEDS_MANUAL: ${label} | paid-to-apply paywall`;
      } else if (GATED[normSite(info.sourceSite)]) {
        line = `NEEDS_MANUAL: ${label} | ${GATED[normSite(info.sourceSite)]}`;
      } else if (LIVE && seen.appliedToday!.count >= MAX_PER_DAY) {
        line = `SKIPPED: ${label} | daily application cap (${MAX_PER_DAY}) reached`;
      } else if (/pararius/i.test(info.sourceSite || '') || /pararius\./i.test(info.sourceUrl || '')) {
        const r = await applyPararius(info.sourceUrl!, {
          live: LIVE,
          hint: { address: info.address || undefined, neighborhood: info.neighborhood || undefined, priceEur: mt.fields.priceEur, city: mt.fields.city },
        });
        const verb = r.status === 'applied' ? 'APPLIED' : r.status === 'dry_run' ? 'DRY_RUN_OK' : r.status === 'needs_manual' ? 'NEEDS_MANUAL' : 'ERROR';
        line = finishLine(`${verb}: ${label} | ${r.reason || 'move-in ' + (r.availableFrom || 'n/a')}`, r);
        if (r.status === 'applied') { seen.appliedToday!.count++; if (info.address) seen.addresses.push(normAddr(info.address)); }
      } else if (normSite(info.sourceSite) === 'vbo' || /vastgoednederland/i.test(info.sourceUrl || '')) {
        const r = await applyVbo(info.sourceUrl!, {
          live: LIVE,
          hint: { address: info.address || undefined, neighborhood: info.neighborhood || undefined, priceEur: mt.fields.priceEur, city: mt.fields.city },
        });
        const verb = r.status === 'applied' ? 'APPLIED' : r.status === 'dry_run' ? 'DRY_RUN_OK' : r.status === 'needs_manual' ? 'NEEDS_MANUAL' : 'ERROR';
        line = finishLine(`${verb}: ${label} | ${r.reason || 'move-in ' + (r.availableFrom || 'n/a')}`, r);
        if (r.status === 'applied') { seen.appliedToday!.count++; if (info.address) seen.addresses.push(normAddr(info.address)); }
      } else {
        // Every other source: fast adaptive DOM filler, with the slow vision agent as a last resort.
        const hint = { address: info.address || undefined, neighborhood: info.neighborhood || undefined, priceEur: mt.fields.priceEur, city: mt.fields.city, sourceSite: info.sourceSite || undefined };
        let r: any = await applyForm(info.sourceUrl!, { live: LIVE, hint });
        if (r.status === 'needs_manual' && /no fillable contact form/i.test(r.reason || '')) {
          r = await applyGeneric(info.sourceUrl!, { live: LIVE, hint });
        }
        const verb = r.status === 'applied' ? 'APPLIED' : r.status === 'dry_run' ? 'DRY_RUN_OK' : r.status === 'needs_manual' ? 'NEEDS_MANUAL' : 'ERROR';
        line = finishLine(`${verb}: ${label} | ${r.reason || r.status}`, r);
        if (r.status === 'applied') { seen.appliedToday!.count++; if (info.address) seen.addresses.push(normAddr(info.address)); }
      }
      transient = /NEEDS_MANUAL|ERROR/.test(line.split(':')[0]) && TRANSIENT.test(line);
    } catch (e) {
      line = `ERROR: ${mt.matchId} | ${(e as Error).message.slice(0, 60)}`;
      transient = TRANSIENT.test((e as Error).message);
    }
    // Only CONSUME a match (mark it seen) on a LIVE run. In DRY-RUN we are just
    // testing: marking it seen here would burn a fresh listing so it never gets
    // a real application. seen.json is only persisted below when LIVE too.
    // Transient load/network failures are NOT consumed: they get MAX_RETRIES
    // attempts across later runs (fresh proxy IPs each time) before giving up.
    if (LIVE) {
      if (!transient) {
        seen.matchIds.push(mt.matchId);
        if (seen.retries) delete seen.retries[mt.matchId];
      } else {
        seen.retries ??= {};
        const n = (seen.retries[mt.matchId] ?? 0) + 1;
        if (n >= MAX_RETRIES) {
          seen.matchIds.push(mt.matchId);
          delete seen.retries[mt.matchId];
          line += ` | giving up after ${MAX_RETRIES} attempts`;
        } else {
          seen.retries[mt.matchId] = n;
          line += ` | will retry next run (attempt ${n}/${MAX_RETRIES})`;
        }
      }
    }
    console.log(' -', line);
    summary.push(line);
    // Always record the resolved street address and the real listing link (fall
    // back to the Stekkies redirect, which still resolves to the listing) so the
    // email can surface them prominently.
    entries.push({
      status: line.split(':')[0].trim(),
      address: info?.address || null,
      url: info?.sourceUrl || mt.redirectUrl || '',
      site: info?.sourceSite || '?',
      price: mt.fields.priceEur ? `EUR ${mt.fields.priceEur}` : '',
      raw: line,
    });
    try {
      mkdirSync(join(__dirname, '..', 'logs'), { recursive: true });
      appendFileSync(join(__dirname, '..', 'logs', 'results.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* non-fatal */ }
  }
  // Complete any half-done applications: VBO/leadflow sends a "Bevestig jouw
  // e-mail" double-opt-in after we submit; the lead only reaches the agent once
  // that link is clicked. LIVE only, runs every time (confirmations arrive
  // minutes after a submit, often landing between runs).
  let optinNote = '';
  if (LIVE) {
    try {
      const n = await confirmPendingOptIns((m) => console.log('  optin:', m));
      if (n) { optinNote = `CONFIRMED: clicked ${n} email opt-in link(s) (leadflow/agency double opt-in)`; summary.push(optinNote); }
    } catch (e) {
      console.log('opt-in confirm failed:', (e as Error).message);
    }
  }

  // Persist dedupe state only on LIVE runs. DRY-RUN must not write seen.json,
  // otherwise a test run consumes fresh matches and the daily cron never applies.
  if (LIVE) saveSeen(seen);
  else console.log('DRY-RUN: not persisting seen.json (no matches consumed).');

  if (entries.length || optinNote) {
    // Notification email: each listing leads with its STREET ADDRESS and a
    // clickable LISTING LINK on their own lines, then the site/price/outcome.
    const ICON: Record<string, string> = { APPLIED: '✅', DRY_RUN_OK: '📝', NEEDS_MANUAL: '⚠️', SKIPPED: '⏭️', ERROR: '❌' };
    const block = (e: Entry): string => {
      const head = `${ICON[e.status] || '•'} ${e.status}: ${e.address || '(street address not resolved)'}`;
      const meta = [e.site !== '?' ? e.site : '', e.price].filter(Boolean).join(' · ');
      // Everything after "STATUS: label" in the raw line = the outcome/reason (+ replay url).
      const detail = e.raw.split(' | ').slice(1).join(' | ');
      const metaLine = [meta, detail].filter(Boolean).join(' · ');
      return [head, `   Listing: ${e.url || '(no link)'}`, metaLine ? `   ${metaLine}` : ''].filter(Boolean).join('\n');
    };
    const applied = entries.filter((e) => e.status === 'APPLIED').length;
    const body =
      `Stekkies auto-apply run (${LIVE ? 'LIVE' : 'DRY-RUN'}) — ${entries.length} listing(s) processed, ${applied} applied\n\n` +
      entries.map(block).join('\n\n') +
      (optinNote ? `\n\n${optinNote}` : '') + '\n';
    const subject = `[Homemaker] ${applied ? `applied to ${applied} listing(s)` : `processed ${entries.length} listing(s)`}`;
    try {
      await sendApplicationEmail({ to: process.env.GMAIL_USER!, subject, text: body });
      console.log('\nSummary emailed to you.');
    } catch (e) {
      console.log('\nemail failed:', (e as Error).message);
    }
  } else {
    console.log('Nothing new to process.');
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
