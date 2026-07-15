/**
 * Backfill: read recent Stekkies match emails, open each match page with the
 * saved login, and emit ready-to-store rows (JSON). One browser session for all.
 *
 * Run:  npx tsx src/backfill.ts
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchStekkiesMatches } from './watch-inbox.ts';
import { readMatchPage } from './read-match.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { contextId } = JSON.parse(readFileSync(join(__dirname, '..', 'context.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

async function main() {
  const emails = await fetchStekkiesMatches(15);
  const matches: any[] = [];
  const seen = new Set<string>();
  for (const e of emails) {
    for (const l of e.links) {
      if (seen.has(l.matchId)) continue;
      seen.add(l.matchId);
      matches.push({ matchId: l.matchId, redirectUrl: l.redirectUrl, fields: e.fields, emailDate: e.date });
    }
  }
  console.log(`▸ ${matches.length} unique matches to process.\n`);

  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contextId, persist: false }, verified: true, os: 'mac' },
    timeout: 900,
  } as any);
  console.log(`  Session: https://www.browserbase.com/sessions/${session.id}\n`);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const rows: any[] = [];
  for (const m of matches) {
    try {
      const info = await readMatchPage(page, m.redirectUrl);
      const row = {
        match_id: m.matchId,
        address: info.address,
        city: m.fields.city ?? null,
        price_eur: m.fields.priceEur ?? null,
        bedrooms: m.fields.bedrooms ?? null,
        surface_m2: m.fields.surfaceM2 ?? null,
        source_site: info.sourceSite,
        source_url: info.sourceUrl,
        match_url: m.redirectUrl,
        paid_to_apply: info.paidToApply,
        response_letter: info.responseLetter,
        status: info.paidToApply ? 'needs_manual' : 'new',
      };
      rows.push(row);
      console.log(`  ✓ ${m.matchId}  ${info.sourceSite ?? '?'}  €${m.fields.priceEur ?? '?'}  ${info.paidToApply ? '⚠ paid-to-apply' : ''}`);
    } catch (e) {
      console.log(`  ✗ ${m.matchId}: ${(e as Error).message}`);
    }
  }
  await browser.close();

  console.log('\n===ROWS_JSON_START===');
  console.log(JSON.stringify(rows));
  console.log('===ROWS_JSON_END===');
  process.exit(0);
}

main().catch((e) => { console.error('✗ backfill failed:', e); process.exit(1); });
