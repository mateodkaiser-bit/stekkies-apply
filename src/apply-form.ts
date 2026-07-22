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
import { clickSubmit, verifySubmission, loadBlockedStatus, captureProof } from './submit-form.ts';
import { sendListingApplication } from './send-email.ts';

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
  const browserSettings: any = { solveCaptchas: true, verified: true, os: 'mac' };
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
  return { browser, ctx, page, sessionId: session.id as string };
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

// Fallback field mapper: one cheap Gemini Flash call for fields the regex
// heuristics could not classify (odd Dutch labels, agency-specific wording).
// Returns an index-aligned array of roles (or null).
const ROLES = ['firstName', 'lastName', 'fullName', 'initials', 'email', 'phone', 'message', 'street', 'houseNumber', 'postcode', 'city', 'country', 'consent'];
export async function classifyWithGemini(fields: any[], log: string[]): Promise<(string | null)[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !fields.length) return fields.map(() => null);
  try {
    const prompt = `These form fields were scraped from a rental-agency contact form (Dutch or English). For EACH field pick the single best role from: ${ROLES.join(', ')} — or null if none fits.
Notes: "message" = the motivation/comments/question textarea. "consent" = a REQUIRED terms/privacy agreement checkbox only; newsletter or marketing opt-ins are null. Never guess: when unsure, use null.

Fields (JSON, index-aligned):
${JSON.stringify(fields.map((f, i) => ({ i, tag: f.tag, type: f.type, name: f.name, id: f.id, placeholder: f.placeholder, label: f.label, required: f.required })))}

Return ONLY a JSON array of exactly ${fields.length} entries (role string or null), index-aligned.`;
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    });
    const j: any = await res.json();
    const arr = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
    if (!Array.isArray(arr)) return fields.map(() => null);
    const out = fields.map((_, i) => (ROLES.includes(arr[i]) ? arr[i] : null));
    const n = out.filter(Boolean).length;
    if (n) log.push(`gemini mapped ${n} extra field(s): ${out.filter(Boolean).join(', ')}`);
    return out;
  } catch (e) {
    log.push('gemini field-mapping failed: ' + (e as Error).message.slice(0, 60));
    return fields.map(() => null);
  }
}

function selectorFor(f: any): string | null {
  if (f.name) return `[name="${f.name}"]`;
  if (f.id) return `#${(f.id as string).replace(/([^\w-])/g, '\\$1')}`;
  return null;
}

// Find the agency's contact email on a listing that has no web form. Prefers
// mailto: links (the agent's real address), then falls back to email-shaped text.
// Skips vendor/no-reply noise and our own address so we never email ourselves.
async function findContactEmail(page: any, selfEmail: string): Promise<string | null> {
  const emails: string[] = await page.evaluate(() => {
    const found: string[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href^="mailto:" i]'))) {
      const e = (a as HTMLAnchorElement).href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
      if (e.includes('@')) found.push(e);
    }
    if (!found.length) {
      const text = document.body ? document.body.innerText : '';
      const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) found.push(m[0].toLowerCase());
    }
    return found;
  });
  const BAD = /noreply|no-reply|donotreply|do-not-reply|example\.(com|org|net)|sentry|wixpress|@wix|cloudflare|googlemail\.com$|@2x|\.png|\.jpg|webmaster|postmaster/i;
  const self = (selfEmail || '').toLowerCase();
  const seen = new Set<string>();
  for (const e of emails) {
    if (e === self || BAD.test(e) || seen.has(e)) continue;
    seen.add(e);
    return e; // first clean candidate; mailto links are scanned before body text
  }
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
      let sessionId: string;
      ({ browser, ctx, page, sessionId } = await freshSession(opts.contextId));
      log.push(`replay: https://browserbase.com/sessions/${sessionId}`);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // goto() resolves even on a 403 body, so a blocked proxy IP looks "loaded".
      // Treat a 4xx/5xx main document as a failed load and rotate to a fresh IP.
      const blocked = loadBlockedStatus(resp);
      if (blocked) throw new Error(`http ${blocked}`);
      loaded = true;
      log.push(`loaded on attempt ${attempt}`);
    } catch (e) {
      log.push(`load attempt ${attempt} failed: ${(e as Error).message.slice(0, 30)}`);
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
      // "per" only when it's "per <date>" (per 1-8-2026); bare "per" matches noise like "per maand".
      const a = text.match(/(?:Aanvaarding|Beschikbaar|Oplevering|Available|Ingangsdatum|\bper\s+(?=\d))\s*:?\s*([^\n]{1,40})/i);
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

    // Heuristics missed fields? One Gemini call maps the leftovers before we
    // give up, fall back to email, or bail to the slow vision agent.
    if (mapped.some((x) => !x.cls) && (!hasCore(mapped) || mapped.some((x) => !x.cls && x.f.required))) {
      const idx = mapped.map((x, i) => (!x.cls ? i : -1)).filter((i) => i >= 0);
      const roles = await classifyWithGemini(idx.map((i) => mapped[i].f), log);
      idx.forEach((mi, k) => { if (roles[k]) mapped[mi].cls = roles[k]; });
    }

    if (!hasCore(mapped)) {
      // No web form: many agency listings just publish a contact email. Detect it
      // and send the application by email instead of bailing to the vision agent.
      const email = await findContactEmail(page, m.email);
      if (email) {
        if (LIVE) {
          try {
            const info = await sendListingApplication({ to: email, letter, address: opts.hint?.address });
            log.push(`emailed application to ${email} (accepted: ${(info as any)?.accepted?.join(', ') || 'n/a'})`);
            result = { status: 'applied', reason: `emailed application to ${email}`, letter, availableFrom: details.availableFrom, log };
          } catch (e) {
            log.push(`email send failed: ${(e as Error).message.slice(0, 80)}`);
            result = { status: 'needs_manual', reason: `found agent email ${email} but send failed`, letter, log };
          }
        } else {
          log.push(`would email application to ${email} (dry-run)`);
          result = { status: 'dry_run', reason: `would email application to ${email}`, letter, availableFrom: details.availableFrom, log };
        }
      } else {
        result = { status: 'needs_manual', reason: 'no fillable contact form found', letter, log };
      }
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
            const cb = page.locator(sel).first();
            // Ignore hidden checkboxes: these are usually off-screen cookie/newsletter
            // boxes that classify() mislabels as consent, not part of the contact form.
            if (!(await cb.isVisible().catch(() => false))) { log.push('skip hidden consent'); continue; }
            // Visible consent boxes are often custom-styled (real <input> hidden behind a
            // label), so plain .check() times out. Try check, forced check, then the label.
            try { await cb.check({ timeout: 3000 }); log.push('ok consent'); }
            catch {
              try { await cb.check({ force: true, timeout: 3000 }); log.push('ok consent (forced)'); }
              catch {
                if (f.id) { await page.locator(`label[for="${(f.id as string).replace(/([^\w-])/g, '\\$1')}"]`).first().click({ timeout: 3000 }); log.push('ok consent (label)'); }
                else { await cb.click({ force: true, timeout: 3000 }); log.push('ok consent (click)'); }
              }
            }
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
        const urlBefore = page.url();
        const sub = await clickSubmit(page, log); // Dutch + English, cookie/login-safe
        const tag = opts.hint?.address || opts.hint?.sourceSite || 'form';
        if (!sub) {
          result = { status: 'needs_manual', reason: 'filled but no submit button found', letter, log };
        } else {
          await captureProof(page, tag, log);
          const v = await verifySubmission(page, { urlBefore }); // poll for a real success/failure signal
          log.push(`verify: ${v.verdict} — ${v.detail}`);
          result = v.verdict === 'confirmed'
            ? { status: 'applied', reason: `submitted (confirmed: ${v.detail})`, letter, availableFrom: details.availableFrom, log }
            : v.verdict === 'failed'
              ? { status: 'needs_manual', reason: `submit failed: ${v.detail}`, letter, availableFrom: details.availableFrom, log }
              : { status: 'needs_manual', reason: 'submitted but unconfirmed (verify manually)', letter, availableFrom: details.availableFrom, log };
        }
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
