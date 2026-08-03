/**
 * Recon a source listing: open it and report what applying requires —
 * whether it's reachable (bot-blocked?), needs a login, and what the
 * apply/contact form looks like (fields, file uploads). Read-only; submits nothing.
 *
 * Run:  npx tsx src/recon-source.ts "<listing url>"
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
const url = process.argv[2];
if (!url) throw new Error('usage: tsx src/recon-source.ts "<url>"');

async function main() {
  const session: any = await bb.sessions.create({ browserSettings: {}, timeout: 300 } as any);
  console.log(`Session: https://www.browserbase.com/sessions/${session.id}\n`);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  let httpStatus: number | undefined;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    httpStatus = resp?.status();
  } catch (e) {
    console.log('goto error:', (e as Error).message);
  }
  await page.waitForTimeout(4000);

  // Optional: click a control (by partial text) to reveal a contact/apply form.
  const clickText = process.argv[3];
  if (clickText) {
    try {
      const el = page.getByText(new RegExp(clickText, 'i')).first();
      await el.scrollIntoViewIfNeeded({ timeout: 5000 });
      await el.click({ timeout: 8000 });
      await page.waitForTimeout(4000);
      console.log(`(clicked "${clickText}") → now at ${page.url()}\n`);
    } catch (e) {
      console.log(`(could not click "${clickText}": ${(e as Error).message})\n`);
    }
  }

  const info = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const clickable = Array.from(document.querySelectorAll('button, a'))
      .map((e) => (e.textContent || '').trim())
      .filter((t) => /reage|contact|bezichtig|apply|inschrijv|solliciteer|aanmeld|viewing|response|verhuurmakelaar|bel |e-?mail/i.test(t));
    return {
      title: document.title,
      blocked: /access denied|verify you are human|captcha|unusual traffic|are you a robot|cloudflare|forbidden|geblokkeerd/i.test(text),
      loginish: /log ?in|inloggen|sign in|maak (een )?account|registreer/i.test(text),
      forms: document.querySelectorAll('form').length,
      fileInputs: document.querySelectorAll('input[type=file]').length,
      textInputs: document.querySelectorAll('input[type=text], input[type=email], input[type=tel], textarea').length,
      fields: Array.from(document.querySelectorAll('input, textarea, select'))
        .filter((e) => (e as HTMLInputElement).type !== 'hidden')
        .map((e) => {
          const el = e as HTMLInputElement;
          return { tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', placeholder: el.placeholder || '', required: el.required };
        })
        .slice(0, 25),
      applyControls: [...new Set(clickable)].slice(0, 15),
      textSample: text.replace(/\s+/g, ' ').slice(0, 400),
    };
  });

  console.log('HTTP status :', httpStatus);
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
  process.exit(0);
}

main().catch((e) => { console.error('✗', e); process.exit(1); });
