/**
 * Verify a saved source-site login works, by opening a page with that site's
 * Context and (optionally) clicking a control, then reporting whether we hit a
 * login wall or the real form. Read-only.
 *
 * Run:  npx tsx src/verify-site.ts <siteKey> "<url>" ["click text"]
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

const [, , siteKey, url, clickText] = process.argv;
if (!siteKey || !url) throw new Error('usage: tsx src/verify-site.ts <siteKey> "<url>" ["click text"]');
const contextId = contexts[siteKey];
if (!contextId) throw new Error(`no saved context for "${siteKey}" in contexts.json`);

async function releaseLingering() {
  try {
    const list: any = await (bb as any).sessions.list();
    const arr = Array.isArray(list) ? list : list?.data ?? [];
    for (const s of arr) {
      if (s.contextId === contextId && s.status === 'RUNNING') {
        try { await (bb as any).sessions.update(s.id, { projectId: s.projectId, status: 'REQUEST_RELEASE' }); } catch { /* */ }
      }
    }
  } catch { /* sessions.list unavailable — fine */ }
}

async function main() {
  await releaseLingering();
  await new Promise((r) => setTimeout(r, 6000));

  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contextId, persist: false }, verified: true, os: 'mac' },
    timeout: 300,
  } as any);
  console.log(`Session: https://www.browserbase.com/sessions/${session.id}\n`);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4000);

  if (clickText) {
    try {
      const el = page.getByText(new RegExp(clickText, 'i')).first();
      await el.scrollIntoViewIfNeeded({ timeout: 5000 });
      await el.click({ timeout: 8000 });
      await page.waitForTimeout(4000);
    } catch (e) {
      console.log(`(could not click "${clickText}": ${(e as Error).message})`);
    }
  }

  const finalUrl = page.url();
  const info = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return {
      onLoginPage: /inloggen|\/login|sign in/i.test(location.pathname + ' ' + document.title),
      hasPasswordField: document.querySelectorAll('input[type=password]').length > 0,
      fields: Array.from(document.querySelectorAll('input, textarea, select'))
        .filter((e) => (e as HTMLInputElement).type !== 'hidden')
        .map((e) => {
          const el = e as HTMLInputElement;
          return { tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', placeholder: el.placeholder || '' };
        })
        .slice(0, 25),
      textSample: text.replace(/\s+/g, ' ').slice(0, 350),
    };
  });

  const loggedIn = !info.onLoginPage && !info.hasPasswordField;
  console.log('Final URL   :', finalUrl);
  console.log('Logged in?  :', loggedIn ? 'YES ✅' : 'NO — hit a login wall ✗');
  console.log(JSON.stringify(info, null, 2));

  await browser.close();
  process.exit(0);
}

main().catch((e) => { console.error('✗', e); process.exit(1); });
