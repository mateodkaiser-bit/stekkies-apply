/**
 * Recon a source site's contact/apply form using a saved login Context.
 * Verifies we are logged in (no account wall) and dumps the form fields so we
 * can build a deterministic filler. No AI.
 *
 * Run:  npx tsx src/recon-form.ts <siteKey> "<listing url>"
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

const siteKey = process.argv[2];
const url = process.argv[3];
if (!siteKey || !url) throw new Error('usage: tsx src/recon-form.ts <siteKey> "<url>"');
const contextId = contexts[siteKey];

async function main() {
  const session: any = await bb.sessions.create({
    browserSettings: { context: contextId ? { id: contextId, persist: false } : undefined, solveCaptchas: true },
    proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
    timeout: 200,
  } as any);
  console.log('Session:', `https://www.browserbase.com/sessions/${session.id}`, contextId ? `(context ${siteKey})` : '(no context)');
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  await ctx.route('**/*', (r) => (['font', 'image', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  let page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);

  let clicked = '';
  for (const t of ['Contact met de makelaar', 'Contact', 'Reageer', 'Ik heb interesse', 'Interesse', 'Bezichtiging', 'Plan een bezichtiging', 'Meer informatie', 'Aanvragen', 'Inschrijven']) {
    try {
      await page.getByRole('button', { name: new RegExp(t, 'i') }).or(page.getByRole('link', { name: new RegExp(t, 'i') })).first().click({ timeout: 4000 });
      clicked = t; break;
    } catch { /* next */ }
  }
  console.log('clicked:', clicked || '(none matched)');
  await page.waitForTimeout(3500);
  page = ctx.pages()[ctx.pages().length - 1];
  console.log('tabs:', ctx.pages().length, '| url:', page.url());

  const info = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    return {
      accountWall: /account aanmaken|maak een account|registreer om|log ?in om te|inloggen om/i.test(text),
      hasPassword: document.querySelectorAll('input[type=password]').length > 0,
      fields: Array.from(document.querySelectorAll('input, textarea, select'))
        .filter((e) => (e as HTMLInputElement).type !== 'hidden' && (e as HTMLElement).offsetParent !== null)
        .map((e) => {
          const el = e as HTMLInputElement;
          return { tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', ph: el.placeholder || '', label: (document.querySelector(`label[for="${el.id}"]`)?.textContent || '').trim().slice(0, 45) };
        })
        .slice(0, 30),
    };
  });

  console.log(`accountWall: ${info.accountWall} | hasPassword: ${info.hasPassword} | logged-in: ${!info.accountWall && !info.hasPassword ? 'YES' : 'NO'}`);
  console.log(`FIELDS (${info.fields.length}):`);
  for (const f of info.fields) console.log(`  ${f.label || f.ph || '(no label)'}  [${f.tag}/${f.type} name="${f.name}" id="${f.id}"]`);
  writeFileSync(join(__dirname, '..', 'recon-fields.json'), JSON.stringify(info.fields, null, 2));

  try { await page.screenshot({ path: join(__dirname, '..', `recon-${siteKey}.png`), fullPage: false, timeout: 15_000 }); console.log('screenshot saved'); }
  catch (e) { console.log('screenshot failed:', (e as Error).message.slice(0, 40)); }

  await browser.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
