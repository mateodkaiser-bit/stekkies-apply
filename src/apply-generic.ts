/**
 * Generic applier for any source site (Schep, VBO, Vbt, agency sites, ...).
 * Uses Stagehand's AUTONOMOUS agent (Gemini): it inspects the page, figures out
 * what the contact / viewing-request form needs, maps our data to it, fills what
 * applies, and reports what it filled, what it lacked, and any blocker.
 *
 * ATTEMPTS every listing. Returns needs_manual (with the agent's reason) only
 * when it genuinely cannot apply (login/account/payment wall, no form, blocked).
 *
 * DRY-RUN by default. CLI:  npx tsx src/apply-generic.ts "<url>" [--live]
 */
import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateLetter, type ListingInfo } from './generate-letter.ts';
import { installNetDiet } from './net-diet.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(readFileSync(join(__dirname, '..', 'profile.json'), 'utf8'));

export interface GenericResult {
  status: 'applied' | 'dry_run' | 'needs_manual' | 'error';
  reason?: string; // the agent's report: what it filled, what it lacked, blockers
  letter?: string;
  log: string[];
}

function applicantSummary(): string {
  const [mateo, carlotta] = profile.applicants;
  const f = profile.financials || {};
  // Dutch 06-format phone: sites like Funda/vb&t reject "+31 6 ..." as invalid.
  const phone = String(mateo.phone || '').replace(/^\+31\s?/, '0').replace(/\s/g, '');
  return [
    `First applicant: ${mateo.firstName} ${mateo.lastName}, ${mateo.nationality}, born ${mateo.dob}, email ${mateo.email}, phone ${phone}, ${mateo.occupation}.`,
    `Second applicant: ${carlotta.firstName} ${carlotta.lastName}, ${carlotta.nationality}, born ${carlotta.dob}, ${carlotta.occupation}.`,
    `Household: a couple, 2 tenants, no children, no pets, non-smokers.`,
    `Income: ${mateo.firstName} earns about EUR ${f.grossMonthlyIncomeEur || 4000}/month (self-employed). Guarantor: ${f.guarantor?.relation} (${f.guarantor?.basis}), living abroad (Germany).`,
    `Current home: ${profile.currentTenancy?.address} (renting; landlord reference available).`,
    `Move-in: flexible, but prefer to match whatever date this listing offers.`,
  ].join(' ');
}

function documentsAvailable(): string {
  const d = profile.documents || {};
  return Object.keys(d).map((k) => k.replace(/_/g, ' ')).join(', ');
}

export async function applyGeneric(
  url: string,
  opts: { live?: boolean; hint?: Partial<ListingInfo>; contextId?: string } = {},
): Promise<GenericResult> {
  const log: string[] = [];
  const browserSettings: any = { solveCaptchas: true };
  if (opts.contextId) browserSettings.context = { id: opts.contextId, persist: false };
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: process.env.BROWSERBASE_API_KEY,
    modelName: 'google/gemini-2.5-flash',
    modelClientOptions: { apiKey: process.env.GEMINI_API_KEY },
    browserbaseSessionCreateParams: { proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }], browserSettings } as any,
    verbose: 1,
  });
  if (opts.contextId) log.push('using saved login');
  await stagehand.init();
  const sid = (stagehand as any).browserbaseSessionID;
  if (sid) log.push(`replay: https://browserbase.com/sessions/${sid}`);
  await installNetDiet(stagehand.context, { keepImages: true });
  const page: any = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
  let result: GenericResult = { status: 'error', log };

  try {
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); loaded = true; }
      catch { log.push(`goto ${i + 1} failed`); await page.waitForTimeout(2000); }
    }
    if (!loaded) return { status: 'needs_manual', reason: 'could not load listing (blocked or timeout)', log };
    await page.waitForTimeout(2500);

    // Listing details -> tailored letter.
    const details = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const a = text.match(/(?:Aanvaarding|Beschikbaar|Oplevering|Available|Ingangsdatum|per direct)\s*:?\s*([^\n]{1,40})/i);
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

    // Autonomous agent: figure out the form and complete it.
    const agent = stagehand.agent({
      mode: 'cua',
      model: 'google/gemini-2.5-computer-use-preview-10-2025',
      systemPrompt:
        'You complete apartment viewing-request and contact forms on behalf of a couple applying for rentals in the Netherlands. ' +
        'You are thorough: you actually open the form, fill every relevant field, and ' + (opts.live ? 'then submit it. ' : 'stop before submitting (dry run). ') +
        'You never invent data. Most information-request and contact forms can be submitted WITHOUT an account, so a login or "register" link elsewhere on the page is NOT a reason to stop.',
    } as any);

    const task = [
      'On this rental listing page: find the form to contact the agent, request a viewing, or request more information; OPEN it; FILL every relevant field using ONLY the data below; then ' + (opts.live ? 'SUBMIT it.' : 'stop WITHOUT submitting (dry run).'),
      '',
      'APPLICANT DATA:',
      applicantSummary(),
      '',
      `Documents we can provide if asked: ${documentsAvailable()}.`,
      '',
      'For any message / motivation / comments / question field, paste this exact text:',
      `"""${letter}"""`,
      '',
      'RULES:',
      '- Actually fill the fields. Do NOT stop right after opening the form.',
      '- Only fill fields that apply; do not invent values you were not given.',
      '- A login or register link on the page is NOT a blocker. Only treat it as blocked if THIS form cannot be submitted without first creating an account or paying (for example the submit button opens a signup or payment page, or the form clearly states that submitting creates an account).',
      '',
      'End your final reply with EXACTLY one status line, choosing the single best match:',
      'STATUS: SUBMITTED | STATUS: FILLED_NOT_SUBMITTED | STATUS: BLOCKED_ACCOUNT | STATUS: BLOCKED_PAYMENT | STATUS: NO_FORM | STATUS: FAILED',
    ].join('\n');

    const res: any = await agent.execute({ instruction: task, maxSteps: 18 });
    const message: string = res?.message || '';
    log.push('agent finished. steps: ' + (res?.actions?.length ?? '?'));

    // Read the agent's explicit STATUS verdict (reliable) instead of keyword-guessing.
    const verdict = (message.match(/STATUS:\s*(SUBMITTED|FILLED_NOT_SUBMITTED|BLOCKED_ACCOUNT|BLOCKED_PAYMENT|NO_FORM|FAILED)/i)?.[1] || 'FAILED').toUpperCase();
    const reasonMap: Record<string, string> = {
      SUBMITTED: 'submitted',
      FILLED_NOT_SUBMITTED: opts.live ? 'filled but could not submit' : 'dry-run: filled, not submitted',
      BLOCKED_ACCOUNT: 'account or login required to submit',
      BLOCKED_PAYMENT: 'payment required to submit',
      NO_FORM: 'no contact form found on the page',
      FAILED: 'agent could not complete the form',
    };
    const reason = reasonMap[verdict] || 'agent could not complete the form';
    log.push('verdict: ' + verdict);

    try { await page.screenshot({ path: join(__dirname, '..', 'apply-generic.png'), fullPage: false, timeout: 15_000 }); log.push('screenshot saved'); } catch { /* */ }

    if (verdict === 'SUBMITTED') {
      result = { status: opts.live ? 'applied' : 'dry_run', reason, letter, log };
    } else if (verdict === 'FILLED_NOT_SUBMITTED') {
      result = { status: opts.live ? 'needs_manual' : 'dry_run', reason, letter, log };
    } else {
      result = { status: 'needs_manual', reason, letter, log };
    }
  } catch (e) {
    result = { status: 'error', reason: (e as Error).message.slice(0, 120), log };
  } finally {
    await stagehand.close().catch(() => {});
  }
  return result;
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) throw new Error('usage: tsx src/apply-generic.ts "<url>" [--live]');
  applyGeneric(url, { live: process.argv.includes('--live'), hint: { city: 'Den Haag' } })
    .then((r) => { console.log('\n' + r.log.join('\n')); console.log('\nSTATUS:', r.status); console.log('AGENT REPORT:', r.reason); process.exit(0); });
}
