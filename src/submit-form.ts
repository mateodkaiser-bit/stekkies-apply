/**
 * Robust submit-button click, shared by every applier.
 *
 * WHY THIS EXISTS: rental contact forms are served in BOTH Dutch and English.
 * The same Pararius listing is at pararius.nl (button reads "Versturen") or
 * pararius.com (button reads "Send"), and other agencies mix languages too.
 * The old per-applier submit loops only tried a fixed list of Dutch words, so
 * on an English page they found no button and the form was filled but never
 * sent ("filled but no submit button found").
 *
 * FORM FIELD names are language-independent (e.g. contact_agent_huurprofiel_form
 * [first_name]) so filling already works in both languages; only the submit
 * button TEXT differs. So here we do NOT rely on a fixed word list: we scan
 * every visible, enabled button / submit input, match its text against a
 * Dutch+English submit vocabulary, skip cookie-consent and login/register
 * buttons, and click the best candidate. Real <input|button type=submit> are
 * tried first (they are almost always the true submit), then broader controls.
 *
 * Returns the text we clicked (truthy = submitted), or '' if nothing matched.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dutch + English submit vocab. Covers pararius.nl "Versturen" and pararius.com
// "Send", plus Verstuur/Verzend(en)/Reageer/Inzenden/Aanvraag and Send message.
const SUBMIT_RE =
  /verstuur|versturen|verzend|verzenden|reageer|inzenden|aanvraag|verzoek|send|submit|send message/i;

// Never click these even if they happen to contain a submit-ish word: cookie
// banners, login/register walls, and cancel/close controls.
const AVOID_RE =
  /cookie|voorkeur|accepteer|weiger|instellingen|preferences|settings|annuleer|cancel|sluit|\bclose\b|terug|inloggen|log ?in|registreer|register|aanmaken/i;

export async function clickSubmit(page: any, log: string[]): Promise<string> {
  // Two passes: real submit controls first, then any button-like element. The
  // whole scan is retried after a short settle because these forms are React:
  // filling the fields can trigger a re-render that briefly detaches the submit
  // button, and a single-pass scan would then wrongly report "no button".
  //
  // We scan the main frame AND every child iframe: some agencies embed the whole
  // contact form (fields + submit) inside an iframe, so a main-frame-only scan
  // finds nothing. Playwright's CSS engine already pierces OPEN shadow roots, so
  // shadow-DOM submit buttons are covered by the selectors below.
  const passes = ['button[type=submit], input[type=submit]', 'button, input[type=button], [role=button]'];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const frame of page.frames()) {
      for (const selector of passes) {
        const loc = frame.locator(selector);
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          let text = '';
          try {
            text = ((await el.innerText({ timeout: 1000 }).catch(() => '')) ||
              (await el.getAttribute('value').catch(() => '')) ||
              (await el.getAttribute('aria-label').catch(() => '')) || '')
              .replace(/\s+/g, ' ').trim();
          } catch { continue; }
          if (!text || !SUBMIT_RE.test(text) || AVOID_RE.test(text)) continue;
          try {
            if (!(await el.isVisible().catch(() => false))) continue;
            if (await el.isDisabled().catch(() => false)) continue;
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ timeout: 5000 });
            log.push(`LIVE submit via: "${text}"`);
            return text;
          } catch { /* try next candidate */ }
        }
      }
    }
    if (attempt === 0) await page.waitForTimeout(1500); // let a re-render settle, then re-scan
  }
  // Last resort: no button matched our vocab (icon-only submit, exotic label, or
  // a control we cannot click). Ask the FORM that holds the filled fields to
  // submit itself. requestSubmit() fires the native submit event + validation,
  // so React/handler-based forms still run their onSubmit — unlike form.submit(),
  // which we deliberately avoid because it bypasses handlers and can half-post.
  const viaForm = await requestSubmitFallback(page, log);
  if (viaForm) return viaForm;

  log.push('LIVE submit: NO BUTTON FOUND');
  return '';
}

// Programmatic fallback: find the form that contains the email/message field the
// applier just filled and call requestSubmit() on it. Runs in every frame.
async function requestSubmitFallback(page: any, log: string[]): Promise<string> {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form')) as HTMLFormElement[];
      const target = forms.find((f) =>
        f.querySelector('input[type=email], textarea, [name*="email" i], [name*="mail" i], [name*="bericht" i], [name*="message" i]'),
      );
      if (!target || typeof target.requestSubmit !== 'function') return false;
      target.requestSubmit();
      return true;
    }).catch(() => false);
    if (ok) { log.push('LIVE submit via: form.requestSubmit() fallback'); return 'form.requestSubmit()'; }
  }
  return '';
}

// After a live submit, save a screenshot + the final URL so a "no confirmation
// seen" result can be audited by eye instead of trusted blindly. Best-effort.
export async function captureProof(page: any, tag: string, log: string[]): Promise<void> {
  const safe = (tag || 'submit').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'submit';
  try { log.push(`post-submit url: ${await page.url()}`); } catch { /* */ }
  try {
    const dir = join(__dirname, '..', 'logs', 'proof');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${safe}.png`), fullPage: false, timeout: 15_000 });
    log.push(`post-submit proof: logs/proof/${safe}.png`);
  } catch { /* non-fatal */ }
}

// ────────────────────────────────────────────────────────────────────────────
// Submission VERIFICATION.
//
// The old behaviour trusted a successful button click as "applied" and only used
// confirmation text to reword the reason. That produced FALSE positives: a form
// that silently failed validation (required consent unticked, a field empty), or
// a submit POST that hit a 403/WAF block, was still logged as "submitted". Two
// sampled proofs confirmed it — an empty VBO form and a bare "403 Forbidden".
//
// verifySubmission() instead POLLS the page after submit and returns a verdict:
//   - 'confirmed' : a real success signal appeared (thank-you text, or a redirect
//                   to a bedankt/success URL).
//   - 'failed'    : a hard negative appeared (403/blocked/error page, or a visible
//                   validation error while the form is still on screen).
//   - 'uncertain' : neither — the click happened but we cannot prove delivery.
// Callers mark ONLY 'confirmed' as applied; everything else is needs_manual so a
// human can verify, and nothing is reported as sent that we cannot stand behind.
// ────────────────────────────────────────────────────────────────────────────

// Strict success signals. These require a completion verb ("has been sent",
// "reactie is verzonden", "bedankt voor je reactie") so a bare field LABEL like
// "Your message" on the un-submitted form never counts as a confirmation.
const CONFIRM_RE =
  /bedankt voor (?:je|jouw|uw)|hartelijk dank|dank voor (?:je|jouw|uw) (?:bericht|reactie|aanvraag|interesse|inschrijving)|(?:reactie|bericht|aanvraag|inschrijving|aanmelding) is (?:verstuurd|verzonden|ontvangen|binnen|in goede orde)|we hebben (?:je|jouw|uw) [^.]{0,30}(?:ontvangen|in goede orde ontvangen)|(?:aanvraag|reactie|bericht|inschrijving|aanmelding) ontvangen|succesvol (?:verzonden|verstuurd|ontvangen|ingediend|ingeschreven)|we nemen (?:zo snel mogelijk |z\.s\.m\.? )?contact|neemt? [^.]{0,25}contact met (?:je|jou|u) op|binnen [^.]{0,15}(?:werkdagen|dagen|uur)[^.]{0,25}contact|je bent ingeschreven|thank you for (?:your|contacting|reaching|getting)|thanks for (?:your|reaching|getting|contacting)|your (?:message|request|enquiry|inquiry|reaction|response|application|interest) (?:has been|was|is)? ?(?:sent|received|submitted|forwarded|registered)|has been (?:sent|received|submitted|registered) successfully|message (?:has been )?sent|successfully (?:sent|submitted|received|registered)|we(?:'ve| have| will| ?'ll) (?:received your|be in touch|contact you)|(?:our|the) (?:agent|team|office|broker|makelaar) will (?:contact|be in touch|reach)/i;

// A blocked / error page (WAF, proxy IP ban, rate limit, Cloudflare challenge).
// Matched only on SHORT bodies / the title so a stray "forbidden" in a full
// listing's footer does not trip it.
const ERROR_PAGE_RE =
  /\b40[13]\b|forbidden|access denied|not authorized|unauthorized|\b429\b|too many requests|rate limit|just a moment|attention required|verify you are (?:a )?human|checking your browser|error 1020/i;

// A client-side validation error keeping the form on screen (submit rejected).
const VALIDATION_RE =
  /is verplicht|verplicht veld|vul (?:dit|alle|het) .*in|dit veld is|graag invullen|selecteer|akkoord met de voorwaarden|geef .*toestemming|required field|this field is required|please (?:fill|enter|complete|accept|check|agree|tick)|is required|invalid email|ongeldig|voer .*in/i;

// A URL that indicates a post-submit success/redirect.
const SUCCESS_URL_RE = /bedankt|dank|thank|thanks|success|geslaagd|verzonden|verstuurd|confirmation|bevestig|received|\/sent\b|\/done\b/i;

export type SubmitVerdict = 'confirmed' | 'failed' | 'uncertain';

// Gather visible text across the main frame AND every child iframe (rental
// contact forms — and their thank-you state — are often inside an iframe), plus
// the document title and URL.
async function pageSnapshot(page: any): Promise<{ text: string; title: string; url: string; len: number }> {
  let text = '';
  for (const frame of page.frames()) {
    const t = await frame.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (t) text += '\n' + t;
  }
  const title = await page.title().catch(() => '');
  let url = '';
  try { url = page.url(); } catch { /* */ }
  return { text, title, url, len: text.replace(/\s+/g, ' ').trim().length };
}

function isErrorPage(snap: { text: string; title: string; len: number }): string | null {
  const hay = `${snap.title}\n${snap.text}`;
  const m = hay.match(ERROR_PAGE_RE);
  if (!m) return null;
  // Only trust it on an error-page-shaped page: a short body, or the signal is in
  // the <title>. Full listings that merely contain the word are not blocks.
  if (snap.len < 800 || ERROR_PAGE_RE.test(snap.title)) return m[0];
  return null;
}

function isSuccessUrl(url: string, urlBefore: string): boolean {
  if (!url || url === urlBefore) return false;
  try {
    const u = new URL(url);
    return SUCCESS_URL_RE.test(u.pathname + u.search);
  } catch { return false; }
}

// Is the contact form we just filled gone from the page (across all frames)?
// A submitted form is typically replaced by a thank-you state, so the message /
// email inputs disappear. Used only as a positive signal when the page ALSO
// navigated away, to avoid mistaking a multi-step form for a success.
async function isContactFormGone(page: any): Promise<boolean> {
  for (const frame of page.frames()) {
    const present = await frame.evaluate(() => {
      const vis = (el: any) => el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return Array.from(document.querySelectorAll('textarea, input[type=email], input[name*="mail" i], input[name*="bericht" i], input[name*="message" i]')).some(vis);
    }).catch(() => false);
    if (present) return false; // a fillable contact field is still visible somewhere
  }
  return true;
}

// Poll for up to ~timeoutMs after a submit click and classify the outcome.
export async function verifySubmission(
  page: any,
  opts: { urlBefore: string; timeoutMs?: number } = { urlBefore: '' },
): Promise<{ verdict: SubmitVerdict; detail: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 16_000);
  let last: { text: string; title: string; url: string; len: number } = { text: '', title: '', url: '', len: 0 };
  while (Date.now() < deadline) {
    last = await pageSnapshot(page);
    const err = isErrorPage(last);
    if (err) return { verdict: 'failed', detail: `blocked/error page ("${err}")` };
    if (CONFIRM_RE.test(last.text)) return { verdict: 'confirmed', detail: 'success message shown' };
    if (isSuccessUrl(last.url, opts.urlBefore)) return { verdict: 'confirmed', detail: 'redirected to a confirmation page' };
    await page.waitForTimeout(1200);
  }
  // Timed out with no explicit success text. A visible validation error means the
  // submit was rejected.
  if (VALIDATION_RE.test(last.text)) return { verdict: 'failed', detail: 'form validation error (submit rejected)' };
  // If the page navigated away AND the contact form is gone (and it is not an
  // error page, checked above), the submit was accepted even though the success
  // wording was not one we recognise. Requiring a URL change keeps a still-on-
  // screen validation error (same URL) from being mistaken for success.
  if (last.url && last.url !== opts.urlBefore && (await isContactFormGone(page))) {
    return { verdict: 'confirmed', detail: 'navigated away after submit, form no longer present' };
  }
  return { verdict: 'uncertain', detail: 'no confirmation signal after submit' };
}

// True if a page load returned a blocking HTTP status (proxy IP ban / WAF).
// goto() resolves on a 403 body, so callers must check the response explicitly.
export function loadBlockedStatus(resp: any): number | null {
  try {
    const s = typeof resp?.status === 'function' ? resp.status() : null;
    return s && s >= 400 ? s : null;
  } catch { return null; }
}

// Back-compat shim (kept so any external caller still resolves); the appliers now
// use verifySubmission. Best-effort single read, strict success signal only.
export async function confirmSent(page: any): Promise<boolean> {
  try {
    const snap = await pageSnapshot(page);
    return CONFIRM_RE.test(snap.text);
  } catch { return false; }
}
