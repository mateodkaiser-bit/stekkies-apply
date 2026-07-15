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
  const passes = ['button[type=submit], input[type=submit]', 'button, input[type=button], [role=button]'];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const selector of passes) {
      const loc = page.locator(selector);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        let text = '';
        try {
          text = ((await el.innerText({ timeout: 1000 }).catch(() => '')) ||
            (await el.getAttribute('value').catch(() => '')) || '')
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
    if (attempt === 0) await page.waitForTimeout(1500); // let a re-render settle, then re-scan
  }
  log.push('LIVE submit: NO BUTTON FOUND');
  return '';
}

// After clicking submit, confirm the form actually went through instead of just
// trusting the click. Rental sites show a thank-you / "bericht verstuurd" state
// (Dutch or English) or clear the form. Returns true when a success signal is
// visible. Best-effort: a false does NOT prove failure (some sites redirect),
// so callers use it to ENRICH the result, not to override a successful click.
const SENT_RE =
  /bedankt|verzonden|verstuurd|succesvol|we nemen .*contact|thank you|has been sent|message sent|successfully sent|we(?:'| ha)ve received|your (?:message|request|enquiry|inquiry)/i;

export async function confirmSent(page: any): Promise<boolean> {
  try {
    const txt: string = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return SENT_RE.test(txt);
  } catch { return false; }
}
