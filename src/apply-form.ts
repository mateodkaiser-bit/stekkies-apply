/**
 * Generic ADAPTIVE form filler. Reads a page's form fields straight from the DOM
 * (no screenshots, no per-step vision), maps our profile data to them by their
 * labels/names/types, and fills fast with deterministic Playwright. Handles the
 * long tail of agency contact forms without per-site code and without the slow
 * computer-use agent.
 *
 * DRY-RUN by default; pass live:true to submit.
 * CLI:  npx tsx src/apply-form.ts "<url>" [--live]
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

export interface ApplyResult {
  status: 'applied' | 'dry_run' | 'needs_manual' | 'error';
  reason?: string;
  letter?: string;
  availableFrom?: string | null;
  log: string[];
}

async function freshSession(contextId?: string) {
  const browserSettings: any = { solveCaptchas: true };
  if (contextId) browserSettings.context = { id: contextId, persist: false };
  const session: any = await bb.sessions.create({
    browserSettings,
    proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
    timeout: 220,
  } as any);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  await ctx.route('**/*', (r) => (['font', 'image', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { browser, ctx, page };
}

// Read visible form fields straight from the DOM. No named inner functions (tsx/esbuild __name safe).
async function scanFields(page: any): Promise<any[]> {
  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input, textarea, select'));
    const out: any[] = [];
    for (const el of els as any[]) {
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
      if ((el as HTMLElement).offsetParent === null && type !== 'checkbox') continue;
      const id = el.id || '';
      const lbl = id ? document.querySelector('label[for="' + (window as any).CSS.escape(id) + '"]') : null;
      const label = ((lbl ? lbl.textContent : '') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      out.push({ tag: el.tagName.toLowerCase(), type, name: el.name || '', id, placeholder: el.placeholder || '', autocomplete: el.getAttribute('autocomplete') || '', label: label.slice(0, 60), required: !!el.required });
    }
    return out;
  });
}

// Map a field to a role from its label/name/placeholder/type.
function classify(f: any): string | null {
  const s = `${f.label} ${f.name} ${f.placeholder} ${f.autocomplete} ${f.id}`.toLowerCase();
  if (f.tag === 'textarea' || /bericht|message|motivat|opmerking|toelichting|vraag|comment/.test(s)) return 'message';
  if (f.type === 'email' || /e-?mail/.test(s)) return 'email';
  if (f.type === 'tel' || /telefoon|phone|mobiel|\btel\b|gsm/.test(s)) return 'phone';
  if (f.type === 'checkbox' && /akkoord|privacy|voorwaarden|toestemming|agree|consent|policy/.test(s)) return 'consent';
  if (/voorletter|initial/.test(s)) return 'initials';
  if (/postcode|postal|\bzip\b/.test(s)) return 'postcode';
  if (/huisnummer|house.?number|address.?number|huisnr/.test(s)) return 'houseNumber';
  if (/woonplaats|\bplaats\b|\bcity\b|gemeente/.test(s)) return 'city';
  if (/\bland\b|country/.test(s)) return 'country';
  if (/straat|\bstreet\b|\badres\b|address/.test(s)) return 'street';
  if (/achternaam|last.?name|surname|family.?name/.test(s)) return 'lastName';
  if (/voornaam|first.?name|given.?name/.test(s)) return 'firstName';
  if (/volledige naam|full.?name|uw naam|your name|\bnaam\b/.test(s)) return 'fullName';
  return null;
}

function selectorFor(f: any): string | null {
  if (f.name) return `[name="${f.name}"]`;
  if (f.id) return `#${(f.id as string).replace(/([^\w-])/g, '\\$1')}`;
  return null;
}

export async function applyForm(url: string, opts: { live?: boolean; hint?: Partial<ListingInfo>; contextId?: string } = {}): Promise<ApplyResult> {
  const LIVE = !!opts.live;
  const m = profile.applicants[0];
  const phone = String(m.phone || '').replace(/^\+31\s?/, '0').replace(/\s/g, '');
  const log: string[] = [];

  let browser: any, ctx: any, page: any, loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      ({ browser, ctx, page } = await freshSession(opts.contextId));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      loaded = true;
      log.push(`loaded on attempt ${attempt}`);
    } catch {
      log.push(`load attempt ${attempt} failed`);
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
    }
  }
  if (!loaded || !page) return { status: 'needs_manual', reason: 'blocked the load after 3 fresh IPs', log };

  let result: ApplyResult = { status: 'error', log };
  try {
    await page.waitForTimeout(2500);

    const details = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const a = text.match(/(?:Aanvaarding|Beschikbaar|Oplevering|Available|Ingangsdatum|per)\s*:?\s*([^\n]{1,40})/i);
      const d = document.querySelector('[class*="description"], [class*="omschrijving"]');
      const desc = (d ? d.textContent || '' : text).replace(/\s+/g, ' ').trim();
      return { availableFrom: a ? a[1].trim() : null, description: desc.slice(0, 1000) };
    });
    const letter = await generateLetter({
      address: opts.hint?.address, city: opts.hint?.city || 'Den Haag', neighborhood: opts.hint?.neighborhood,
      priceEur: opts.hint?.priceEur, availableFrom: details.availableFrom || opts.hint?.availableFrom,
      description: details.description, sourceSite: opts.hint?.sourceSite,
    });
    log.push(`letter generated (${letter.split(/\s+/).length} words)`);

    // Find the form. If email/message not visible yet, click contact-ish controls to reveal it.
    const hasCore = (arr: any[]) => arr.some((x) => x.cls === 'email') || arr.some((x) => x.cls === 'message');
    let mapped = (await scanFields(page)).map((f) => ({ f, cls: classify(f) }));
    if (!hasCore(mapped)) {
      for (const t of ['Contact met de makelaar', 'Reageer op deze woning', 'Reageer', 'Ik heb interesse', 'Interesse', 'Contact', 'Meer informatie', 'Bezichtiging', 'Aanvragen']) {
        try { await page.getByRole('button', { name: new RegExp(t, 'i') }).or(page.getByRole('link', { name: new RegExp(t, 'i') })).first().click({ timeout: 3500 }); } catch { /* next */ }
        await page.waitForTimeout(1800);
        mapped = (await scanFields(page)).map((f) => ({ f, cls: classify(f) }));
        if (hasCore(mapped)) { log.push(`form revealed via "${t}"`); break; }
      }
    }

    if (!hasCore(mapped)) {
      result = { status: 'needs_manual', reason: 'no fillable contact form found', letter, log };
    } else {
      const addr = profile.currentAddress || {};
      const values: Record<string, string> = {
        firstName: m.firstName, lastName: m.lastName, fullName: `${m.firstName} ${m.lastName}`,
        initials: m.firstName ? m.firstName[0] + '.' : '',
        email: m.email, phone, message: letter,
        street: addr.street || '', houseNumber: addr.houseNumber || '', postcode: addr.postcode || '',
        city: addr.city || 'Den Haag', country: addr.country || 'Netherlands',
      };
      const unmapped: string[] = [];
      let coreFilled = 0;
      for (const { f, cls } of mapped) {
        const sel = selectorFor(f);
        if (!sel) { if (f.required && cls) unmapped.push(f.label || f.name); continue; }
        try {
          if (f.tag === 'select') {
            const optlist: any[] = await page.locator(sel).locator('option').evaluateAll((os: any) => os.map((o: any) => ({ v: o.value, t: (o.textContent || '').trim() })));
            const pick = optlist.find((o) => o.v && /bezichtig|interesse|informatie|viewing|contact|huur|woning/i.test(o.t)) || optlist.find((o) => o.v && o.t);
            if (pick) { await page.selectOption(sel, pick.v); log.push(`ok select ${f.label || f.name}`); }
          } else if (cls === 'consent') {
            await page.locator(sel).first().check({ timeout: 5000 }); log.push('ok consent');
          } else if (cls) {
            await page.locator(sel).first().fill(values[cls], { timeout: 8000 }); log.push(`ok ${cls}`);
            if (cls === 'email' || cls === 'message') coreFilled++;
          } else if (f.required && f.type !== 'checkbox') {
            unmapped.push(f.label || f.name || '(unnamed)');
          }
        } catch { log.push(`fail ${cls || f.tag}`); }
      }
      if (unmapped.length) log.push(`unmapped required: ${unmapped.slice(0, 4).join(', ')}`);

      await page.waitForTimeout(800);
      try { await page.screenshot({ path: join(__dirname, '..', 'apply-form.png'), fullPage: false, timeout: 15_000 }); log.push('screenshot saved'); } catch { /* */ }

      if (coreFilled === 0) {
        result = { status: 'needs_manual', reason: 'found a form but could not fill the key fields', letter, log };
      } else if (LIVE) {
        let sub = '';
        for (const t of ['Verstuur', 'Versturen', 'Verzend', 'Verzenden', 'Reageer', 'Verstuur bericht', 'Aanvragen', 'Versturen aanvraag']) {
          try { await page.getByRole('button', { name: new RegExp(`^${t}`, 'i') }).first().click({ timeout: 4000 }); sub = t; break; } catch { /* */ }
        }
        log.push(`LIVE submit via: ${sub || 'NO BUTTON FOUND'}`);
        await page.waitForTimeout(3000);
        result = sub ? { status: 'applied', reason: 'submitted', letter, availableFrom: details.availableFrom, log }
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
  if (!url) throw new Error('usage: tsx src/apply-form.ts "<url>" [--live]');
  applyForm(url, { live: process.argv.includes('--live'), hint: { city: 'Den Haag' } })
    .then((r) => { console.log('\n' + r.log.join('\n')); console.log('\nSTATUS:', r.status, r.reason || ''); process.exit(0); });
}
