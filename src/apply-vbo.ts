/**
 * VBO applier (aanbod.vastgoednederland.nl). Deterministic: uses the saved VBO
 * login, reads the listing details, generates a tailored letter, and fills the
 * simple 5-field contact form. Fast and reliable, unlike the generic agent.
 *
 * DRY-RUN by default; pass live:true to submit.
 * CLI:  npx tsx src/apply-vbo.ts "<url>" [--live]
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateLetter, type ListingInfo } from './generate-letter.ts';
import { clickSubmit, confirmSent } from './submit-form.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));
const profile = JSON.parse(readFileSync(join(__dirname, '..', 'profile.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

export interface ApplyResult {
  status: 'applied' | 'dry_run' | 'needs_manual' | 'error';
  reason?: string;
  letter?: string;
  availableFrom?: string | null;
  log: string[];
}

async function freshSession() {
  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contexts.vbo, persist: false }, solveCaptchas: true, verified: true, os: 'mac' },
    proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
    timeout: 220,
  } as any);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  await ctx.route('**/*', (r) => (['font', 'image', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { browser, ctx, page };
}

export async function applyVbo(url: string, opts: { live?: boolean; hint?: Partial<ListingInfo> } = {}): Promise<ApplyResult> {
  const LIVE = !!opts.live;
  const m = profile.applicants[0];
  const phone = String(m.phone || '').replace(/^\+31\s?/, '0').replace(/\s/g, '');
  const log: string[] = [];

  if (!contexts.vbo) return { status: 'needs_manual', reason: 'no VBO login saved', log };

  let browser: any, ctx: any, page: any, loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      ({ browser, ctx, page } = await freshSession());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      loaded = true;
      log.push(`loaded on attempt ${attempt}`);
    } catch (e) {
      log.push(`load attempt ${attempt} failed`);
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
    }
  }
  if (!loaded || !page) return { status: 'needs_manual', reason: 'VBO blocked the load after 3 fresh IPs', log };

  let result: ApplyResult = { status: 'error', log };
  try {
    await page.waitForTimeout(2500);

    const details = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      // "per" only when it's "per <date>" (per 1-8-2026); bare "per" matches noise like "per maand".
      const a = text.match(/(?:Aanvaarding|Beschikbaar|Oplevering|Ingangsdatum|\bper\s+(?=\d))\s*:?\s*([^\n]{1,40})/i);
      const d = document.querySelector('[class*="description"], [class*="omschrijving"]');
      const desc = (d ? d.textContent || '' : text).replace(/\s+/g, ' ').trim();
      return { availableFrom: a ? a[1].trim() : null, description: desc.slice(0, 1000) };
    });
    const letter = await generateLetter({
      address: opts.hint?.address, city: opts.hint?.city || 'Den Haag', neighborhood: opts.hint?.neighborhood,
      priceEur: opts.hint?.priceEur, availableFrom: details.availableFrom || opts.hint?.availableFrom,
      description: details.description, sourceSite: 'VBO',
    });
    log.push(`letter generated (${letter.split(/\s+/).length} words)`);

    // Ensure the contact form is actually VISIBLE (it may be inline, or revealed by a button/link).
    const FN = '[name="first_name"]';
    let formReady = await page.locator(FN).first().isVisible().catch(() => false);
    if (formReady) {
      log.push('form visible inline');
      await page.locator(FN).first().scrollIntoViewIfNeeded().catch(() => {});
    } else {
      for (const t of ['Contact met de makelaar', 'Reageer', 'Contact', 'Interesse', 'Meer informatie']) {
        try { await page.getByRole('link', { name: new RegExp(t, 'i') }).or(page.getByRole('button', { name: new RegExp(t, 'i') })).first().click({ timeout: 4000 }); } catch { /* try next control */ }
        try { await page.locator(FN).first().waitFor({ state: 'visible', timeout: 6000 }); formReady = true; log.push(`form opened via "${t}"`); break; } catch { /* not visible yet */ }
      }
    }

    if (!formReady) {
      result = { status: 'needs_manual', reason: 'could not open the VBO contact form', letter, log };
    } else {
      const setInput = async (name: string, value: string) => {
        if (!value) return;
        try { await page.locator(`[name="${name}"]`).first().fill(value, { timeout: 8000 }); log.push(`ok ${name}`); }
        catch { log.push(`fail ${name}`); }
      };
      await setInput('first_name', m.firstName);
      await setInput('last_name', m.lastName);
      await setInput('phone', phone);
      await setInput('email', m.email);
      await setInput('msg', letter);

      await page.waitForTimeout(800);
      try { await page.screenshot({ path: join(__dirname, '..', 'apply-vbo.png'), fullPage: false, timeout: 15_000 }); log.push('screenshot saved'); } catch { /* */ }

      if (LIVE) {
        const sub = await clickSubmit(page, log); // Dutch + English, cookie/login-safe
        await page.waitForTimeout(3000);
        const confirmed = sub ? await confirmSent(page) : false;
        if (sub) log.push(confirmed ? 'confirmation state detected' : 'no confirmation text (may still have sent)');
        result = sub ? { status: 'applied', reason: confirmed ? 'submitted (confirmed)' : 'submitted (no confirmation seen)', letter, availableFrom: details.availableFrom, log }
                     : { status: 'needs_manual', reason: 'filled but no submit button found', letter, log };
      } else {
        result = { status: 'dry_run', letter, availableFrom: details.availableFrom, log };
      }
    }
  } catch (e) {
    result = { status: 'error', reason: (e as Error).message.slice(0, 80), log };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return result;
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) throw new Error('usage: tsx src/apply-vbo.ts "<url>" [--live]');
  applyVbo(url, { live: process.argv.includes('--live'), hint: { city: 'Den Haag' } })
    .then((r) => { console.log('\n' + r.log.join('\n')); console.log('\nSTATUS:', r.status, r.reason || ''); if (r.letter) console.log('\nLETTER:\n' + r.letter); process.exit(0); });
}
