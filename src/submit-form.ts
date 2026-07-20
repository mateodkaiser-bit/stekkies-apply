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

// After clicking submit, confirm the form actually went through instead of just
// trusting the click. Rental sites show a thank-you / "bericht verstuurd" state
// (Dutch or English) or clear the form. Returns true when a success signal is
// visible. Best-effort: a false does NOT prove failure (some sites redirect),
// so callers use it to ENRICH the result, not to override a successful click.
const SENT_RE =
  /bedankt|verzonden|verstuurd|succesvol|gelukt|aanvraag is binnen|reactie is (?:verstuurd|verzonden|ontvangen)|we nemen .*contact|thank you|has been sent|message sent|successfully sent|we(?:'| ha)ve received|your (?:message|request|enquiry|inquiry)/i;

export async function confirmSent(page: any): Promise<boolean> {
  try {
    const txt: string = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return SENT_RE.test(txt);
  } catch { return false; }
}
