/**
 * One-time Stekkies login → saved Browserbase Context.
 *
 * Run:  npm run login
 *
 * This starts a cloud browser, lands it on Stekkies, and prints an INTERACTIVE
 * live-view URL. You sign in there yourself (your password never touches this code),
 * then press Enter. Browserbase saves the resulting cookies into a persistent Context
 * so every future run is already logged in.
 */
import 'dotenv/config';
import { Browserbase } from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = join(__dirname, '..', 'context.json');

const apiKey = process.env.BROWSERBASE_API_KEY;
if (!apiKey) {
  console.error('✗ Missing BROWSERBASE_API_KEY in .env');
  process.exit(1);
}
const bb = new Browserbase({ apiKey });

// Where to land for login. Override with STEKKIES_URL in .env if your dashboard is elsewhere.
const STEKKIES_URL = process.env.STEKKIES_URL ?? 'https://stekkies.com';

async function getOrCreateContext(): Promise<string> {
  if (existsSync(CONTEXT_FILE)) {
    const saved = JSON.parse(readFileSync(CONTEXT_FILE, 'utf8'));
    if (saved.contextId) {
      console.log(`↻ Reusing saved context ${saved.contextId}`);
      return saved.contextId;
    }
  }
  const ctx = await bb.contexts.create();
  writeFileSync(CONTEXT_FILE, JSON.stringify({ contextId: ctx.id }, null, 2));
  console.log(`＋ Created new context ${ctx.id} (saved to context.json)`);
  return ctx.id;
}

async function createSession(contextId: string) {
  const params: any = {
    browserSettings: { context: { id: contextId, persist: true } },
    timeout: 900, // Free plan caps a session at 15 minutes.
  };
  try {
    return await bb.sessions.create(params);
  } catch (err) {
    // Some SDK versions still want an explicit projectId in the create body.
    try {
      const projects: any = await bb.projects.list();
      const projectId = Array.isArray(projects) ? projects[0]?.id : projects?.data?.[0]?.id;
      if (projectId) {
        params.projectId = projectId;
        return await bb.sessions.create(params);
      }
    } catch {
      /* fall through to original error */
    }
    throw err;
  }
}

function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(message, () => { rl.close(); resolve(); }));
}

async function main() {
  const contextId = await getOrCreateContext();

  console.log('▸ Starting a cloud browser session…');
  const session = await createSession(contextId);
  console.log(`  Session replay: https://www.browserbase.com/sessions/${session.id}`);

  // Connect over CDP only to navigate — so you land on a real Stekkies page, not about:blank.
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(STEKKIES_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    console.log(`  (Couldn't auto-open ${STEKKIES_URL}; navigate manually in the live view.)`);
  }

  const debug = await bb.sessions.debug(session.id);
  console.log('\n────────────────────────────────────────────────────────');
  console.log('👉 Open this INTERACTIVE live view and log in to Stekkies:');
  console.log(`\n${debug.debuggerFullscreenUrl}\n`);
  console.log('   • Sign in the way you normally do');
  console.log('   • Get all the way to your Matches page');
  console.log('────────────────────────────────────────────────────────');

  await waitForEnter('\nWhen you can see your matches, press Enter here to save the login… ');

  console.log('▸ Saving… (closing the browser so Browserbase syncs your login into the context)');
  await browser.close();
  await new Promise((r) => setTimeout(r, 5_000));

  console.log(`\n✅ Done. Context ${contextId} now carries your Stekkies login and is reused on every run.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ Login setup failed:', err);
  process.exit(1);
});
