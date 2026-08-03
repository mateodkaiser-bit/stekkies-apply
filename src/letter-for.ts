/**
 * Generate the tailored application letter for one or more listing URLs and print
 * them. Opens each page to read its real move-in date / neighbourhood / description.
 *
 * Run:  npx tsx src/letter-for.ts "<url>" ["<url>" ...]
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateLetter } from './generate-letter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
const urls = process.argv.slice(2);

async function readDetails(url: string) {
  for (let i = 0; i < 3; i++) {
    let browser: any;
    try {
      const session: any = await bb.sessions.create({
        browserSettings: { context: { id: contexts.pararius, persist: false }, solveCaptchas: true },
        proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
        timeout: 120,
      } as any);
      browser = await chromium.connectOverCDP(session.connectUrl);
      const ctx = browser.contexts()[0];
      await ctx.route('**/*', (r: any) => (['font', 'image', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
      const d = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        const a = text.match(/(?:Aanvaarding|Beschikbaar|Available|Oplevering|Offered since)\s*:?\s*([^\n]{1,40})/i);
        const n = text.match(/(?:Buurt|Wijk|Neighbourhood|District)\s*:?\s*([^\n]{1,40})/i);
        const desc = document.querySelector('[class*="description"]');
        const h1 = document.querySelector('h1');
        const priceM = text.match(/€\s*([\d.,]+)/);
        return {
          address: (h1 ? h1.textContent || '' : '').replace(/\s+/g, ' ').trim().slice(0, 90),
          availableFrom: a ? a[1].trim() : null,
          neighborhood: n ? n[1].trim() : null,
          description: (desc ? desc.textContent || '' : text).replace(/\s+/g, ' ').trim().slice(0, 1100),
          priceEur: priceM ? Number(priceM[1].replace(/[.,]/g, '')) : null,
        };
      });
      await browser.close().catch(() => {});
      return d;
    } catch {
      if (browser) await browser.close().catch(() => {});
    }
  }
  return null;
}

async function main() {
  for (const url of urls) {
    const d = await readDetails(url);
    console.log('\n===================================================');
    console.log(url);
    if (!d) { console.log('(could not load listing)'); continue; }
    console.log(`address="${d.address}" | available=${d.availableFrom || '?'} | buurt=${d.neighborhood || '?'} | EUR ${d.priceEur || '?'}`);
    const letter = await generateLetter({ address: d.address, city: 'Den Haag', neighborhood: d.neighborhood || undefined, priceEur: d.priceEur || undefined, availableFrom: d.availableFrom || undefined, description: d.description, sourceSite: 'Pararius' });
    console.log('\n----- LETTER -----\n' + letter);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
