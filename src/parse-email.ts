/**
 * Parse a Stekkies match email.
 *
 * Detection: emails from help@stekkies.com with subject starting
 *   "We found new Stekkies for you: ..."
 *
 * The "View match" button wraps a customer.io click-tracker whose path segment
 * is base64-encoded JSON containing the real href. We decode it (rather than
 * following the tracker) to get the canonical redirect URL + a stable match id.
 */

export interface MatchLink {
  /** Raw email.stekkies.com/e/c/... tracker link as it appears in the email. */
  trackedUrl: string;
  /** Canonical www.stekkies.com/en/api/v1/redirect/<id> link (needs login to resolve). */
  redirectUrl: string;
  /** Stable unique id for the match — used as the dedupe key. */
  matchId: string;
}

export interface ListingFields {
  address?: string; // street + house number, e.g. "Spuistraat 65D"
  neighborhood?: string; // the card's second component, e.g. "Centrum"
  city?: string; // from the subject, e.g. "Den Haag"
  priceEur?: number; // e.g. 1200
  bedrooms?: number; // e.g. 2
  surfaceM2?: number; // e.g. 62
}

/** Detection: is this email a Stekkies match alert? */
export function isStekkiesMatchEmail(from: string, subject: string): boolean {
  return (
    /help@stekkies\.com/i.test(from) &&
    /^We found new Stekkies for you/i.test(subject.trim())
  );
}

function base64UrlDecode(seg: string): string {
  const norm = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 ? '='.repeat(4 - (norm.length % 4)) : '';
  return Buffer.from(norm + pad, 'base64').toString('utf8');
}

// A real listing link resolves to either /api/v1/redirect/<id> or /s/he/<id>.
// Footer/nav/app-store links (also tracker-wrapped) won't match → filtered out.
const LISTING_ID = /(?:\/redirect\/|\/s\/he\/)([a-f0-9]{16,})/i;

/**
 * Decode one tracker link → { redirectUrl, matchId }, or null if it isn't a
 * listing link. Handles both the customer.io /e/c/<base64> wrapper and a bare
 * listing URL. Canonicalizes to the redirect form so the two links Stekkies
 * emits for the same listing collapse to one match id.
 */
export function decodeStekkiesLink(
  trackedUrl: string,
): { redirectUrl: string; matchId: string } | null {
  let target = trackedUrl;
  const seg = trackedUrl.match(/\/e\/c\/([^/]+)/);
  if (seg) {
    try {
      const json = JSON.parse(base64UrlDecode(seg[1]));
      if (json?.href) target = json.href;
    } catch {
      /* keep the raw url */
    }
  }
  const id = target.match(LISTING_ID);
  if (!id) return null; // not a listing link (footer / nav / app store)
  return {
    redirectUrl: `https://www.stekkies.com/en/api/v1/redirect/${id[1]}`,
    matchId: id[1],
  };
}

/** Pull every unique match link out of the email HTML. */
export function extractMatchLinks(html: string): MatchLink[] {
  const links: MatchLink[] = [];
  const seen = new Set<string>();
  // Scan every URL; decodeStekkiesLink keeps only genuine listing links.
  const re = /https?:\/\/[^\s"'<>)]+/g;
  for (const raw of html.match(re) ?? []) {
    const decoded = decodeStekkiesLink(raw);
    if (decoded && !seen.has(decoded.matchId)) {
      seen.add(decoded.matchId);
      links.push({ trackedUrl: raw, ...decoded });
    }
  }
  return links;
}

/**
 * Best-effort extraction of the listing card fields from the email text.
 * Works on the plaintext part or on HTML-stripped text. Validated further
 * once we're reading real emails, but the shape matches the known template.
 */
export function parseListingFields(subject: string, text: string): ListingFields {
  const out: ListingFields = {};

  const cityM = subject.match(/for you:\s*([^(]+?)\s*\(/i);
  if (cityM) out.city = cityM[1].trim();

  const priceM = text.match(/€\s*([\d.,]+)/);
  if (priceM) out.priceEur = Number(priceM[1].replace(/[.,]/g, ''));

  const bedM = text.match(/Bedrooms?\s*:?\s*(\d+)/i);
  if (bedM) out.bedrooms = Number(bedM[1]);

  const surfM = text.match(/Surface\s*:?\s*(\d+)\s*m/i);
  if (surfM) out.surfaceM2 = Number(surfM[1]);

  return out;
}

// ── Per-listing card parsing ────────────────────────────────────────────────
//
// parseListingFields() above reads the WHOLE email, so on a multi-listing email
// every listing got the first card's price/bedrooms/surface — listing #2 in the
// 2026-08-18 20:35 email was quoted €1857 when it actually asks €1882 — and the
// address was never populated at all (the field was declared and never set), so
// the orchestrator fell back to scraping the match page, which resolved an
// address for only 20 of 154 reads (87% "address not resolved").
//
// The email already carries the answer, per listing, for free. Each card in the
// plaintext part looks like:
//
//     ( http://www.stekkies.com/en/api/v1/redirect/<matchId>?utm_... )
//
//     Juliana van Stolberglaan 5 B, Haagse Hout
//     € 1857
//     Bedrooms: 2
//     Surface: 97 m2
//     View match ( .../redirect/<matchId>?utm_... )
//     Is something wrong with this listing? ( .../s/he/<matchId>?utm_... )
//
// so a card runs from the first mention of its match id to the first mention of
// the next one, and the address is the line directly above the price line.

const ID_SCAN = /(?:\/redirect\/|\/s\/he\/)([a-f0-9]{16,})/gi;

/** Parse one card's slice of the email text. */
function parseCard(card: string): ListingFields {
  const out: ListingFields = {};

  // The address is the last non-empty, non-URL line before the "€ 1857" line.
  // Anchoring on the price rather than on the link keeps it working whatever
  // decoration Stekkies puts above the card.
  const beforePrice = card.split(/€/)[0] || '';
  const lines = beforePrice
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\//i.test(l) && !/^[()\s·]*$/.test(l));
  const addrLine = lines[lines.length - 1];
  if (addrLine && /[A-Za-z]{3}/.test(addrLine) && addrLine.length <= 90) {
    // "Spuistraat 65D, Centrum" -> address + neighbourhood. Split on the LAST
    // comma: Dutch street names contain commas far less often than the card
    // has a trailing neighbourhood.
    const cut = addrLine.lastIndexOf(',');
    if (cut > 0) {
      out.address = addrLine.slice(0, cut).trim();
      out.neighborhood = addrLine.slice(cut + 1).trim() || undefined;
    } else {
      out.address = addrLine;
    }
  }

  const priceM = card.match(/€\s*([\d.,]+)/);
  if (priceM) out.priceEur = Number(priceM[1].replace(/[.,]/g, ''));
  const bedM = card.match(/Bedrooms?\s*:?\s*(\d+)/i);
  if (bedM) out.bedrooms = Number(bedM[1]);
  const surfM = card.match(/Surface\s*:?\s*(\d+)\s*m/i);
  if (surfM) out.surfaceM2 = Number(surfM[1]);

  return out;
}

/**
 * Parse the email into per-listing fields, keyed by match id.
 * Falls back to {} for a listing whose card we cannot find.
 */
export function parseListingCards(subject: string, text: string): Map<string, ListingFields> {
  const city = subject.match(/for you:\s*([^(]+?)\s*\(/i)?.[1].trim();

  // First mention of each match id, in the order the cards appear.
  const firstIdx = new Map<string, number>();
  const order: string[] = [];
  for (const m of text.matchAll(ID_SCAN)) {
    const id = m[1].toLowerCase();
    if (firstIdx.has(id)) continue;
    firstIdx.set(id, m.index ?? 0);
    order.push(id);
  }

  const out = new Map<string, ListingFields>();
  for (let i = 0; i < order.length; i++) {
    const start = firstIdx.get(order[i])!;
    const end = i + 1 < order.length ? firstIdx.get(order[i + 1])! : text.length;
    const f = parseCard(text.slice(start, end));
    if (city) f.city = city;
    out.set(order[i], f);
  }
  return out;
}
