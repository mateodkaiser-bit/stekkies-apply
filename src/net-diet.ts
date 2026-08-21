/**
 * Proxy-bandwidth diet.
 *
 * Every browser session runs through the Browserbase NL proxy, and proxy
 * bandwidth — not browser minutes — is what actually goes into overage on the
 * Developer plan: the Jul 14 - Aug 14 invoice was 2,629 MB against a 1,000 MB
 * allowance, $19.55 over, while browser hours came in at 1,064 of 6,000 (free).
 * So every byte the page pulls costs money and every minute does not.
 *
 * Listing pages are image-heavy (photo galleries, map tiles, hero video) and
 * carry the usual analytics/ad/chat payloads. None of that matters for finding
 * and filling a contact form, so we refuse to fetch it. Stylesheets and scripts
 * ARE kept: the appliers rely on computed visibility and on site JS to render
 * the form.
 */

// Third-party junk: analytics, tag managers, ads, session replay, chat widgets.
// Matched against the request URL host, so it costs nothing to be generous.
const JUNK_HOST =
  /(google-analytics|googletagmanager|googlesyndication|doubleclick|google(ads|adservices)|facebook\.(net|com)\/tr|connect\.facebook|hotjar|clarity\.ms|fullstory|mouseflow|luckyorange|segment\.(io|com)|mixpanel|amplitude|intercom|drift|tawk\.to|crisp\.chat|zendesk|hubspot|klaviyo|criteo|taboola|outbrain|adroll|bing\.com\/bat|snapchat|tiktok|pinterest|cookiebot|onetrust|trustpilot|newrelic|sentry\.io|bugsnag|datadoghq)/i;

/**
 * Install the diet on a Playwright BrowserContext.
 *
 * @param keepImages  set for the vision/CUA applier, which has to SEE the page.
 *                    Trackers and media are still blocked in that mode.
 */
export async function installNetDiet(ctx: any, opts: { keepImages?: boolean } = {}): Promise<void> {
  const heavy = opts.keepImages ? ['font', 'media'] : ['font', 'image', 'media'];
  await ctx.route('**/*', (r: any) => {
    const req = r.request();
    if (heavy.includes(req.resourceType())) return r.abort();
    if (JUNK_HOST.test(req.url())) return r.abort();
    return r.continue();
  });
}
