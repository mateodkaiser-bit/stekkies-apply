/**
 * Read a Stekkies match page (with the logged-in Context) and extract the
 * fields we need to apply: the source site + "Go to listing" URL, whether it's
 * paid-to-apply, the response letter, and the address.
 */
import type { Page } from 'playwright-core';

export interface MatchPageInfo {
  finalUrl: string;
  sourceUrl: string | null;
  sourceSite: string | null;
  paidToApply: boolean;
  responseLetter: string | null;
  address: string | null;
}

const SITE_NAMES: Record<string, string> = {
  'huurwoningen.nl': 'Huurwoningen',
  'pararius.nl': 'Pararius',
  'pararius.com': 'Pararius',
  'funda.nl': 'Funda',
  'kamernet.nl': 'Kamernet',
  'huurstunt.nl': 'Huurstunt',
  'rentola.nl': 'Rentola',
  'huislijn.nl': 'Huislijn',
};

const NOISE = /stekkies\.com|apple\.com|google\.com|leafletjs|openstreetmap|carto|customer\.io/i;

export async function readMatchPage(page: Page, redirectUrl: string): Promise<MatchPageInfo> {
  await page.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4000); // let the SPA settle

  const raw = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a')).map((a) => ({
      t: (a.textContent || '').trim(),
      h: (a as HTMLAnchorElement).href,
    }));
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null;
    return { bodyText: document.body?.innerText || '', anchors, letter: ta ? ta.value : null, url: location.href };
  });

  const external = raw.anchors.filter((a) => a.h && !NOISE.test(a.h));
  const goListing = raw.anchors.find((a) => /go to listing/i.test(a.t) && !NOISE.test(a.h));
  const sourceUrl = goListing?.h || external[0]?.h || null;

  let sourceSite: string | null = null;
  const sm = raw.bodyText.match(/(?:Source|Found on)\s*:?\s*([A-Za-z][\w .&-]+)/i);
  if (sm) sourceSite = sm[1].split('\n')[0].trim();
  if (!sourceSite && sourceUrl) {
    try {
      const h = new URL(sourceUrl).hostname.replace(/^www\./, '');
      sourceSite = SITE_NAMES[h] || h;
    } catch { /* ignore */ }
  }

  const paidToApply = /paid to apply/i.test(raw.bodyText);

  let address: string | null = null;
  const am = raw.bodyText.match(/\n([A-Z][A-Za-z'’.\- ]+,\s*[A-Z][A-Za-z' -]+)\n/);
  if (am) address = am[1].trim();

  return { finalUrl: raw.url, sourceUrl, sourceSite, paidToApply, responseLetter: raw.letter, address };
}
