/** Smoke test: confirm Gemini can drive a Browserbase browser via Stagehand. */
import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  modelName: 'google/gemini-2.5-flash',
  modelClientOptions: { apiKey: process.env.GEMINI_API_KEY },
  verbose: 1,
});

async function main() {
  await stagehand.init();
  console.log('Stagehand session:', `https://www.browserbase.com/sessions/${stagehand.browserbaseSessionID}`);
  const sh: any = stagehand;
  console.log('stagehand.act/extract?', typeof sh.act, typeof sh.extract);
  const page: any = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
  await page.goto('https://example.com');
  const res = await sh.extract({
    instruction: 'extract the main heading and first paragraph',
    schema: z.object({ heading: z.string(), paragraph: z.string() }),
  });
  console.log('✅ Gemini extract result:', JSON.stringify(res));
  await stagehand.close();
  process.exit(0);
}

main().catch((e) => { console.error('✗ smoke failed:', e); process.exit(1); });
