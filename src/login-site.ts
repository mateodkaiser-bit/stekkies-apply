/**
 * One-time login for any source site → saved Browserbase Context.
 * Generalizes the Stekkies login to multiple sites (pararius, funda, …).
 * Context ids are stored per-site in contexts.json.
 *
 * Run:  npx tsx src/login-site.ts <siteKey> <startUrl>
 *   e.g. npx tsx src/login-site.ts pararius https://www.pararius.nl/inloggen
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXTS_FILE = join(__dirname, '..', 'contexts.json');

const [, , siteKey, startUrl] = process.argv;
if (!siteKey || !startUrl) throw new Error('usage: tsx src/login-site.ts <siteKey> <startUrl>');

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

function loadContexts(): Record<string, string> {
  if (existsSync(CONTEXTS_FILE)) return JSON.parse(readFileSync(CONTEXTS_FILE, 'utf8'));
  // migrate legacy single-context file (Stekkies) if present
  const legacy = join(__dirname, '..', 'context.json');
  if (existsSync(legacy)) {
    const { contextId } = JSON.parse(readFileSync(legacy, 'utf8'));
    if (contextId) return { stekkies: contextId };
  }
  return {};
}
const saveContexts = (m: Record<string, string>) => writeFileSync(CONTEXTS_FILE, JSON.stringify(m, null, 2));

async function getOrCreate(key: string): Promise<string> {
  const m = loadContexts();
  if (m[key]) {
    console.log(`↻ Reusing ${key} context ${m[key]}`);
    return m[key];
  }
  const ctx = await bb.contexts.create();
  m[key] = ctx.id;
  saveContexts(m);
  console.log(`＋ Created ${key} context ${ctx.id}`);
  return ctx.id;
}

async function createSession(contextId: string) {
  const params: any = {
    browserSettings: { context: { id: contextId, persist: true }, solveCaptchas: true, verified: true, os: 'mac' },
    proxies: [{ type: 'browserbase', geolocation: { country: 'NL' } }],
    timeout: 300,
  };
  try {
    return await bb.sessions.create(params);
  } catch (err) {
    try {
      const p: any = await bb.projects.list();
      const id = Array.isArray(p) ? p[0]?.id : p?.data?.[0]?.id;
      if (id) { params.projectId = id; return await bb.sessions.create(params); }
    } catch { /* ignore */ }
    throw err;
  }
}

const waitForEnter = (msg: string) =>
  new Promise<void>((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); res(); });
  });

async function main() {
  const contextId = await getOrCreate(siteKey);
  console.log('▸ Starting a cloud browser…');
  const session: any = await createSession(contextId);
  console.log(`  Session: https://www.browserbase.com/sessions/${session.id}`);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    console.log(`  (couldn't auto-open ${startUrl}; navigate manually in the live view)`);
  }

  const debug = await bb.sessions.debug(session.id);
  console.log('\n────────────────────────────────────────');
  console.log(`👉 Open this live view and log in to ${siteKey.toUpperCase()}:`);
  console.log(`\n${debug.debuggerFullscreenUrl}\n`);
  console.log('────────────────────────────────────────');

  await waitForEnter(`\nWhen you're logged in to ${siteKey}, press Enter here to save… `);

  console.log('▸ Saving…');
  await browser.close();
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`\n✅ Saved. ${siteKey} login stored in context ${contextId} (contexts.json).`);
  process.exit(0);
}

main().catch((e) => { console.error('✗ login failed:', e); process.exit(1); });
