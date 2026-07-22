/**
 * VBO applier (aanbod.vastgoednederland.nl).
 *
 * HISTORY / WHY THIS IS NOW A THIN WRAPPER: this file used to fill the contact
 * form with a hand-written list of hard-coded field names (first_name, last_name,
 * phone, email, msg) and NO consent handling. That was wrong on the live form:
 * the fields are named differently and the "Hierbij geef ik ... toestemming"
 * checkbox is REQUIRED. So fills silently failed and the required consent box was
 * never ticked — the submit was rejected while we still logged "applied". A
 * captured proof screenshot showed the empty form with the consent box unchecked.
 *
 * The generic adaptive filler (applyForm) already scans the real fields by
 * label/name/type, maps them (with a Gemini fallback), ticks required consent
 * boxes, and now verifies the submission. VBO's form is a plain
 * name/email/phone/message + consent form, exactly what applyForm handles best.
 * So we delegate to it, passing the saved VBO login context so the session is
 * authenticated. One robust code path, no bespoke selectors to rot.
 *
 * DRY-RUN by default; pass live:true to submit.
 * CLI:  npx tsx src/apply-vbo.ts "<url>" [--live]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyForm, type ApplyResult } from './apply-form.ts';
import type { ListingInfo } from './generate-letter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contexts = JSON.parse(readFileSync(join(__dirname, '..', 'contexts.json'), 'utf8'));

export type { ApplyResult };

export async function applyVbo(url: string, opts: { live?: boolean; hint?: Partial<ListingInfo> } = {}): Promise<ApplyResult> {
  return applyForm(url, {
    live: opts.live,
    contextId: contexts.vbo || undefined, // authenticate with the saved VBO login
    hint: { ...opts.hint, sourceSite: opts.hint?.sourceSite || 'VBO' },
  });
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) throw new Error('usage: tsx src/apply-vbo.ts "<url>" [--live]');
  applyVbo(url, { live: process.argv.includes('--live'), hint: { city: 'Den Haag' } })
    .then((r) => { console.log('\n' + r.log.join('\n')); console.log('\nSTATUS:', r.status, r.reason || ''); if (r.letter) console.log('\nLETTER:\n' + r.letter); process.exit(0); });
}
