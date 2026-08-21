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
import { installNetDiet } from './net-diet.ts';

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
type Seen = {
  matchIds: string[];
  addresses: string[];
  appliedToday?: { date: string; count: number };
  retries?: Record<string, number>;
  // Total Browserbase-spending attempts per match id, counted for EVERY
  // non-success outcome whatever we classified it as. The retry/infra counters
  // above are deliberately forgiving, so a misclassification can make a single
  // listing retry for ever (Van Galenstraat, 2026-08-20: a target-site "403"
  // read as an account problem, 200+ sessions in 36h). This one is the backstop
  // that cannot be talked out of giving up.
  attempts?: Record<string, number>;
  // Browserbase sessions started today, so a runaway of any kind is capped in
  // money terms and not just in listings.
  sessionsToday?: { date: string; count: number };
  // Resolved match-page info, keyed by match id. Reading a Stekkies match page
  // costs a full Browserbase session (~1.7 min of a metered browser minute
  // budget) and the answer never changes, so cache it. This makes a retry — or
  // a listing we bail on for a gated/paywalled source — cost zero sessions the
  // second time round. Lives in seen.json so CI's existing commit step
  // persists it across runs with no workflow change.
  matchInfo?: Record<string, any>;
};
const MATCH_INFO_KEEP = 300;
// Failures where the form was never reached/submitted, so retrying on a later
// run is safe (no double-apply risk) and often succeeds (proxy IP roulette).
const TRANSIENT = /blocked the load|time-?d? ?out|timeout|net::|ECONN|ETIMEDOUT|Target closed|browser has been closed/i;
const MAX_RETRIES = 3;
// Account-level failures: the Browserbase session was never even created, so
// the listing was never opened, let alone applied to. These are NOT the
// listing's fault and must never consume it — not even against the retry
// budget, or an outage lasting longer than MAX_RETRIES runs silently burns
// every match that arrives during it (this is exactly what happened when the
// trial ended on 2026-07-28: 402 "minutes limit", then 403 "Verified mode is
// only available on the Enterprise plan", and 32 listings were consumed
// without a single application being sent).
const INFRA = /\b(401|402|403|429)\b|Enterprise plan|only available on the|minutes limit|quota|rate limit|upgrade|Unauthorized|invalid api key/i;
// ...but INFRA above is matched against a result line that CONTAINS TEXT WE
// SCRAPED FROM THE LISTING SITE (page title / body / validation message). A
// listing site that bot-blocks us renders its own "403" or "429" page, and that
// string used to reach the INFRA test and be read as "our Browserbase account
// is broken" -> never consume the listing, never even tick the retry counter ->
// retry every 5 minutes for ever. Verdicts the appliers derive from page
// CONTENT are the listing's own answer and must never be classified as infra.
const PAGE_VERDICT = /blocked\/error page|form validation error|no contact form|could not fill|agent could not complete|paywall|account or login required|account\/login required/i;
const isInfra = (s: string) => INFRA.test(s) && !PAGE_VERDICT.test(s);
// Hard ceiling on attempts per listing, regardless of classification.
const MAX_ATTEMPTS = 6;
// Hard ceiling on Browserbase sessions per day. Normal traffic is ~15-25
// listings/day at 1-2 sessions each; this only fires when something has gone
// wrong, and it fires before the bill does.
const MAX_SESSIONS_PER_DAY = Number((process.argv.find((a) => a.startsWith('--maxsessions=')) || '').split('=')[1] || 80);
const loadSeen = (): Seen => (existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : { matchIds: [], addresses: [] });
const saveSeen = (s: Seen) => writeFileSync(SEEN, JSON.stringify(s, null, 2));

async function openMatchPage(matchUrl: string, useProxy: boolean) {
  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contexts.stekkies, persist: false } },
    // Only bytes that go through the Browserbase proxy are metered.
    ...(useProxy ? { proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }] } : {}),
    timeout: 120,
  } as any);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  await installNetDiet(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    return await readMatchPage(page, matchUrl);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Reading a Stekkies match page is roughly half of all sessions (one per new
// listing, then cached). Unlike the listing sites, Stekkies is OUR OWN account
// on a site that does not bot-block us, so read it WITHOUT the NL proxy and
// those bytes cost nothing at all — proxy bandwidth is the only metered
// resource (invoice Jul 14-Aug 14: $19.55 of proxy overage, $0.00 of browser
// hours). If the unproxied read comes back with no listing link — a block page,
// a login wall, a geo-gate — fall back to the proxied read once, so the worst
// case is the one session we used to spend unconditionally, plus a cheap probe.
async function readMatch(matchUrl: string, onSession: () => void) {
  onSession();
  try {
    const info = await openMatchPage(matchUrl, false);
    if (info.sourceUrl) return info;
    console.log('   (unproxied match read found no listing link — retrying via the NL proxy)');
  } catch (e) {
    console.log(`   (unproxied match read failed: ${(e as Error).message.slice(0, 60)} — retrying via the NL proxy)`);
  }
  onSession();
  return openMatchPage(matchUrl, true);
}

async function main() {
  const seen = loadSeen();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  if (!seen.appliedToday || seen.appliedToday.date !== today) seen.appliedToday = { date: today, count: 0 };
  if (!seen.sessionsToday || seen.sessionsToday.date !== today) seen.sessionsToday = { date: today, count: 0 };
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
    let infra = false;
    let deferred = false;
    let info: any = null;
    // Money guard. Every listing we process costs 1-2 proxied Browserbase
    // sessions, and proxy bandwidth is the metered resource that actually goes
    // into overage ($0.012/MB past 1 GB). Past the daily session budget we stop
    // and DEFER — the listing is left unconsumed for tomorrow, never discarded.
    if (LIVE && seen.sessionsToday!.count >= MAX_SESSIONS_PER_DAY) {
      deferred = true;
      line = `SKIPPED: ${mt.matchId} | daily Browserbase session budget (${MAX_SESSIONS_PER_DAY}) reached — deferred`;
      console.log(' -', line);
      summary.push(line);
      entries.push({ status: 'SKIPPED', address: null, url: mt.redirectUrl || '', site: '?', price: '', raw: line });
      continue;
    }
    try {
      const cached = seen.matchInfo?.[mt.matchId];
      if (cached) {
        info = cached;
        console.log(`   (cached match info for ${mt.matchId} — no browser session needed)`);
      } else {
        info = await readMatch(mt.redirectUrl, () => { seen.sessionsToday!.count++; });
        (seen.matchInfo ??= {})[mt.matchId] = info;
      }
      const price = mt.fields.priceEur ? `EUR ${mt.fields.priceEur}` : '';
      const label = `${info.address || mt.matchId} (${info.sourceSite || '?'}, ${price})`;

      if (info.address && seen.addresses.includes(normAddr(info.address))) {
        line = `SKIPPED: ${label} | already applied to this address`;
      } else if (info.paidToApply) {
        line = `NEEDS_MANUAL: ${label} | paid-to-apply paywall`;
      } else if (GATED[normSite(info.sourceSite)]) {
        line = `NEEDS_MANUAL: ${label} | ${GATED[normSite(info.sourceSite)]}`;
      } else if (LIVE && seen.appliedToday!.count >= MAX_PER_DAY) {
        // Deferred, NOT declined: we chose not to apply yet. Consuming here
        // would permanently discard a listing we never even looked at, so the
        // cap would quietly destroy the backlog it is meant to postpone.
        deferred = true;
        line = `SKIPPED: ${label} | daily application cap (${MAX_PER_DAY}) reached — deferred to tomorrow`;
      } else if (/pararius/i.test(info.sourceSite || '') || /pararius\./i.test(info.sourceUrl || '')) {
        seen.sessionsToday!.count++;
        const r = await applyPararius(info.sourceUrl!, {
          live: LIVE,
          hint: { address: info.address || undefined, neighborhood: info.neighborhood || undefined, priceEur: mt.fields.priceEur, city: mt.fields.city },
        });
        const verb = r.status === 'applied' ? 'APPLIED' : r.status === 'dry_run' ? 'DRY_RUN_OK' : r.status === 'needs_manual' ? 'NEEDS_MANUAL' : 'ERROR';
        line = finishLine(`${verb}: ${label} | ${r.reason || 'move-in ' + (r.availableFrom || 'n/a')}`, r);
        if (r.status === 'applied') { seen.appliedToday!.count++; if (info.address) seen.addresses.push(normAddr(info.address)); }
      } else if (normSite(info.sourceSite) === 'vbo' || /vastgoednederland/i.test(info.sourceUrl || '')) {
        seen.sessionsToday!.count++;
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
        seen.sessionsToday!.count++;
        let r: any = await applyForm(info.sourceUrl!, { live: LIVE, hint });
        if (r.status === 'needs_manual' && /no fillable contact form/i.test(r.reason || '')) {
          seen.sessionsToday!.count++;
          r = await applyGeneric(info.sourceUrl!, { live: LIVE, hint });
        }
        const verb = r.status === 'applied' ? 'APPLIED' : r.status === 'dry_run' ? 'DRY_RUN_OK' : r.status === 'needs_manual' ? 'NEEDS_MANUAL' : 'ERROR';
        line = finishLine(`${verb}: ${label} | ${r.reason || r.status}`, r);
        if (r.status === 'applied') { seen.appliedToday!.count++; if (info.address) seen.addresses.push(normAddr(info.address)); }
      }
      transient = /NEEDS_MANUAL|ERROR/.test(line.split(':')[0]) && TRANSIENT.test(line) && !PAGE_VERDICT.test(line);
      infra = /NEEDS_MANUAL|ERROR/.test(line.split(':')[0]) && isInfra(line);
    } catch (e) {
      line = `ERROR: ${mt.matchId} | ${(e as Error).message.slice(0, 60)}`;
      transient = TRANSIENT.test((e as Error).message);
      infra = isInfra((e as Error).message);
    }
    // Backstop: count every attempt that cost us a session, whatever we decided
    // it was. Past MAX_ATTEMPTS the listing is consumed even if it looks like an
    // infra problem, because "looks like infra" is exactly the failure mode that
    // burns a browser budget silently.
    const succeeded = /^(APPLIED|DRY_RUN_OK|SKIPPED)/.test(line);
    if (LIVE && !succeeded && !deferred) {
      seen.attempts ??= {};
      const a = (seen.attempts[mt.matchId] ?? 0) + 1;
      seen.attempts[mt.matchId] = a;
      if (a >= MAX_ATTEMPTS && (infra || transient)) {
        infra = false;
        transient = false;
        line += ` | ${MAX_ATTEMPTS} attempts spent — consuming to stop the retry loop`;
      }
    }
    if (LIVE && succeeded && seen.attempts) delete seen.attempts[mt.matchId];
    // Only CONSUME a match (mark it seen) on a LIVE run. In DRY-RUN we are just
    // testing: marking it seen here would burn a fresh listing so it never gets
    // a real application. seen.json is only persisted below when LIVE too.
    // Transient load/network failures are NOT consumed: they get MAX_RETRIES
    // attempts across later runs (fresh proxy IPs each time) before giving up.
    // An account/plan failure means we never reached the listing at all. Leave
    // it completely untouched (not even a retry tick) so it is picked up again
    // as soon as the account is healthy.
    if (LIVE && (infra || deferred)) {
      if (infra) line += ' | account/plan problem — listing left unconsumed, will retry';
    } else if (LIVE) {
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
  // Keep the match-info cache bounded: retain only entries for matches we might
  // still see (recent ids), newest last, so seen.json cannot grow without limit.
  if (seen.matchInfo) {
    const keys = Object.keys(seen.matchInfo);
    if (keys.length > MATCH_INFO_KEEP) {
      for (const k of keys.slice(0, keys.length - MATCH_INFO_KEEP)) delete seen.matchInfo[k];
    }
  }
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
