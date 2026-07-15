/**
 * Verify the saved Stekkies login works, by opening a real match's redirect URL
 * with the saved Context and checking we land on an authenticated match page
 * (not a login screen). Also dumps page text + candidate "Go to listing" links
 * so we can see what the match-page parser will have to work with.
 *
 * Run:  npx tsx src/verify-login.ts
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { contextId } = JSON.parse(readFileSync(join(__dirname, '..', 'context.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

// The real match from your email.
const REDIRECT_URL =
  'https://www.stekkies.com/en/api/v1/redirect/621174882a5f459ebba0461a16932b43';

async function releaseLingering() {
  try {
    const list: any = await (bb as any).sessions.list();
    const arr = Array.isArray(list) ? list : list?.data ?? [];
    for (const s of arr) {
      if (s.contextId === contextId && s.status === 'RUNNING') {
        try {
          await (bb as any).sessions.update(s.id, { projectId: s.projectId, status: 'REQUEST_RELEASE' });
          console.log(`  released lingering session ${s.id} (forces context sync)`);
        } catch { /* ignore */ }
      }
    }
  } catch { /* sessions.list not available in this SDK — fine */ }
}

async function main() {
  console.log('▸ Ensuring the login session is closed so the context is synced…');
  await releaseLingering();
  await new Promise((r) => setTimeout(r, 6000));

  console.log('▸ Opening the match with your saved login (read-only)…');
  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contextId, persist: false }, verified: true, os: 'mac' },
    timeout: 300,
  } as any);
  console.log(`  Session replay: https://www.browserbase.com/sessions/${session.id}`);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.goto(REDIRECT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5000); // let any client-side redirect / SPA settle

  const finalUrl = page.url();
  const title = await page.title();
  const hasPassword = (await page.locator('input[type=password]').count()) > 0;
  const bodyText = (await page.evaluate(() => document.body?.innerText || '')).replace(/\n{2,}/g, '\n').slice(0, 1200);

  // Candidate "Go to listing" / source links (Pararius/Funda/agency).
  const links: { text: string; href: string }[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a'))
      .map((a) => ({ text: (a.textContent || '').trim().slice(0, 40), href: (a as HTMLAnchorElement).href }))
      .filter((l) => l.href && !/stekkies\.com/.test(l.href))
      .slice(0, 15);
  });

  console.log('\n──────── RESULT ────────');
  console.log('Final URL     :', finalUrl);
  console.log('Page title    :', title);
  console.log('Login screen? :', hasPassword ? 'YES — not logged in ✗' : 'no password field (good sign)');
  console.log('\nExternal links found on the page (candidate source listings):');
  for (const l of links) console.log(`  • [${l.text}] ${l.href}`);
  console.log('\n──────── PAGE TEXT (first 1200 chars) ────────\n' + bodyText);

  await browser.close();
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ Verify failed:', e); process.exit(1); });
