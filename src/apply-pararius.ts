/**
 * Pararius applier. Loads the listing (retrying with FRESH proxied sessions so a
 * blocked IP just rotates to a new Dutch IP), reads the listing's real details,
 * generates a tailored letter, then fills the contact form deterministically.
 * DRY-RUN by default; pass live:true to submit.
 *
 * CLI:  npx tsx src/apply-pararius.ts "<url>" [--live]
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateLetter, type ListingInfo } from './generate-letter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));
const profile = JSON.parse(readFileSync(join(__dirname, '..', 'profile.json'), 'utf8'));
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
const F = 'contact_agent_huurprofiel_form';

export interface ApplyResult {
  status: 'applied' | 'dry_run' | 'needs_manual' | 'error';
  reason?: string;
  letter?: string;
  availableFrom?: string | null;
  neighborhood?: string | null;
  log: string[];
}

async function freshSession() {
  const session: any = await bb.sessions.create({
    browserSettings: { context: { id: contexts.pararius, persist: false }, solveCaptchas: true },
    proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
    timeout: 220,
  } as any);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  await ctx.route('**/*', (r) => (['font', 'image', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { browser, ctx, page };
}

export async function applyPararius(
  url: string,
  opts: { live?: boolean; hint?: Partial<ListingInfo> } = {},
): Promise<ApplyResult> {
  const LIVE = !!opts.live;
  const m = profile.applicants[0];
  const phone = String(m.phone || '').replace(/^\+31\s?/, '0').replace(/\s/g, '');
  const log: string[] = [];

  // Load with FRESH sessions (rotating proxy IPs) until one gets through.
  let browser: any, ctx: any, page: any, loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      ({ browser, ctx, page } = await freshSession());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); // fail fast on blocked IPs
      loaded = true;
      log.push(`loaded on attempt ${attempt}`);
    } catch (e) {
      log.push(`load attempt ${attempt} failed: ${(e as Error).message.slice(0, 30)}`);
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
    }
  }
  if (!loaded || !page) {
    return { status: 'needs_manual', reason: 'Pararius blocked the load after 3 fresh proxy IPs', log };
  }

  let result: ApplyResult = { status: 'error', log };
  try {
    await page.waitForTimeout(2500);

    // 1) Listing details for the letter.
    const details = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const a = text.match(/(?:Aanvaarding|Beschikbaar|Oplevering|Available)\s*:?\s*([^\n]{1,40})/i);
      const n = text.match(/(?:Buurt|Wijk)\s*:?\s*([^\n]{1,40})/i);
      const d = document.querySelector('[class*="description"]');
      const desc = (d ? d.textContent || '' : text).replace(/\s+/g, ' ').trim();
      return { availableFrom: a ? a[1].trim() : null, neighborhood: n ? n[1].trim() : null, description: desc.slice(0, 1000) };
    });
    log.push(`details: available=${details.availableFrom || '?'} | buurt=${details.neighborhood || '?'}`);

    // 2) Tailored letter.
    const letter = await generateLetter({
      address: opts.hint?.address, city: opts.hint?.city || 'Den Haag',
      neighborhood: details.neighborhood || opts.hint?.neighborhood, priceEur: opts.hint?.priceEur,
      availableFrom: details.availableFrom || opts.hint?.availableFrom, description: details.description, sourceSite: 'Pararius',
    });
    log.push(`letter generated (${letter.split(/\s+/).length} words)`);

    // 3) Open the contact form.
    let clicked = '';
    for (const t of ['Contact met de makelaar', 'Contact met de aanbieder', 'Reageer', 'Contact']) {
      try {
        await page.getByRole('button', { name: new RegExp(t, 'i') })
          .or(page.getByRole('link', { name: new RegExp(t, 'i') })).first().click({ timeout: 5000 });
        clicked = t; break;
      } catch { /* next */ }
    }
    log.push(`opened contact form via: ${clicked || '(?)'}`);
    await page.waitForTimeout(3500);
    page = ctx.pages()[ctx.pages().length - 1];

    // 4) Fill.
    const setInput = async (name: string, value: string) => {
      if (!value) return;
      try { await page.locator(`[name="${F}[${name}]"]`).first().fill(value, { timeout: 8000 }); log.push(`ok ${name}`); }
      catch (e) { log.push(`fail ${name}`); }
    };
    const getOptions = async (name: string) => {
      try {
        return await page.locator(`select[name="${F}[${name}]"]`).locator('option')
          .evaluateAll((os: any) => os.map((o: any) => ({ v: o.value, t: (o.textContent || '').trim() })));
      } catch { return [] as { v: string; t: string }[]; }
    };
    const setSelect = async (name: string, patterns: RegExp[], avoid?: RegExp) => {
      const opts = await getOptions(name);
      for (const p of patterns) {
        const hit = opts.find((o) => o.v && p.test(o.t) && !(avoid && avoid.test(o.t)));
        if (hit) { await page.selectOption(`select[name="${F}[${name}]"]`, hit.v); log.push(`ok ${name} -> ${hit.t}`); return; }
      }
      log.push(`fail ${name}`);
    };
    const setIncome = async () => {
      const opts = await getOptions('gross_annual_household_income');
      const target = 4000;
      const scored = opts.filter((o) => o.v).map((o) => ({ o, nums: (o.t.match(/\d[\d.]*/g) || []).map((s) => parseInt(s.replace(/\./g, ''), 10)).filter((x) => x > 100) }));
      const pick = scored.find((s) => s.nums.length >= 2 && target >= s.nums[0] && target <= s.nums[1])
        || scored.find((s) => s.nums.length === 1 && target >= s.nums[0] && !/tot|minder|onder/i.test(s.o.t))
        || scored.filter((s) => s.nums.length).sort((a, b) => Math.abs(a.nums[0] - target) - Math.abs(b.nums[0] - target))[0];
      if (pick) { await page.selectOption(`select[name="${F}[gross_annual_household_income]"]`, pick.o.v); log.push(`ok income -> ${pick.o.t}`); }
    };

    await setInput('first_name', m.firstName);
    await setInput('last_name', m.lastName);
    await setInput('phone_number', phone);
    await setInput('date_of_birth', m.dob);
    await setInput('number_of_tenants', '2');
    await setInput('rent_start_date', '2026-10-01');
    await setInput('motivation', letter);
    await setSelect('salutation', [/heer/i]);
    await setSelect('work_situation', [/zelfstandig|zzp|ondernemer|eigen/i, /student/i, /loondienst/i]);
    await setIncome();
    await setSelect('guarantor', [/buitenland|abroad|duitsland/i, /garant|wel|heb|\bja\b/i], /geen/i);
    await setSelect('preferred_living_situation', [/samen|partner|met.*ander|twee|koppel/i, /\bja\b/i]);
    await setSelect('pets', [/nee|geen/i]);
    await setSelect('preferred_contract_period', [/onbepaald|indefinite|langer|jaar|12/i]);
    await setSelect('current_housing_situation', [/huur/i]);

    await page.waitForTimeout(1000);
    try { await page.screenshot({ path: join(__dirname, '..', 'apply-pararius.png'), fullPage: false, timeout: 15_000 }); log.push('screenshot saved'); }
    catch { /* non-fatal */ }

    if (LIVE) {
      let sub = '';
      for (const t of ['Verstuur', 'Verzend', 'Versturen', 'Reageer']) {
        try { await page.getByRole('button', { name: new RegExp(t, 'i') }).first().click({ timeout: 5000 }); sub = t; break; } catch { /* */ }
      }
      log.push(`LIVE submit via: ${sub || 'NO BUTTON FOUND'}`);
      await page.waitForTimeout(3000);
      result = sub ? { status: 'applied', reason: 'submitted', letter, availableFrom: details.availableFrom, neighborhood: details.neighborhood, log }
                   : { status: 'needs_manual', reason: 'filled but no submit button found', letter, log };
    } else {
      result = { status: 'dry_run', letter, availableFrom: details.availableFrom, neighborhood: details.neighborhood, log };
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
  const url = process.argv[2] || 'https://pararius.nl/appartement-te-huur/den-haag/b9f26151/regentesselaan';
  applyPararius(url, { live: process.argv.includes('--live'), hint: { address: 'Regentesselaan', neighborhood: 'Regentessekwartier', priceEur: 700 } })
    .then((r) => { console.log('\n' + r.log.join('\n')); console.log('\nSTATUS:', r.status, r.reason || ''); if (r.letter) console.log('\nLETTER:\n' + r.letter); process.exit(0); });
}
