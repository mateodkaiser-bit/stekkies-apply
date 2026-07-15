# stekkies-autoapply

Personal assistant that watches Stekkies apartment matches and helps apply for viewings.
Built on [Browserbase](https://browserbase.com) (cloud browser) + [Stagehand](https://docs.stagehand.dev) (AI form filling).

> Personal tool, ~5–10 matches/day. Not built to scale.

## Status

Building the **spine** on the Browserbase Free plan:

- [x] Browserbase setup + key verified
- [x] Email parser — detect match email, decode "View match" link → canonical
      redirect URL + stable match id (dedupe key), extract listing fields.
      Built + tested against a real email link. (`src/parse-email.ts`)
- [x] Stekkies login → saved Context (`npm run login`) — verified on a real match
- [x] Resolve match link → match page: "Go to listing" **source URL** extracted
      (verified: match 621174882a… → huurwoningen.nl/…/ermelostraat). `src/verify-login.ts`
- [x] Tracker live — Supabase project `ftupemyojxjumxmocvdq`, schema `stekkies`,
      table `applications` (+ private `stekkies-docs` bucket). Real match logged as row #1.
- [x] Applicant profile + documents captured — `profile.json` + `documents/` (gitignored)
      + Supabase `stekkies.documents` catalog. Binary upload to private bucket pending deploy.
- [ ] Also capture the **response letter** text from the match page
- [x] Gmail watcher — IMAP via "Homemaker" app password; detects + parses real
      Stekkies emails (`src/watch-inbox.ts`). Verified on 5 real matches.
- [x] Orchestrator + backfill — `src/read-match.ts` (source URL/site, paid-to-apply,
      letter) + `src/backfill.ts`. Backfilled 15 real matches into the tracker
      (9 sources, 3 paywalled). Funda + Pararius dominate.
- [ ] **Apply step** — Stagehand + your Gemini key: fill + submit on source site  ← needs Gemini key
- [ ] Deploy always-on (Vercel + Browserbase) + wire Supabase writes (service key)
- [ ] Fill + submit on source site — Stagehand + your Gemini key  ← needs you (key)

## Setup

1. `npm install`
2. Fill in `profile.json` (your details + document file paths).
3. `npm run login` — sign in to Stekkies once in the live view; your login is saved.

## Notes / known limits (Free plan)

- Free = **1 browser-hour/month**, no proxies, no CAPTCHA solving. Fine for building/testing;
  **daily operation needs the Developer plan** ($20/mo) for hours + proxies + auto-CAPTCHA.
- **Funda** is bot-protected and will likely need Developer (proxies + CAPTCHA) or Scale (Verified).
- Failures (login wall / CAPTCHA / no form found) are logged as `Needs manual`, not forced —
  the failure log doubles as the backlog of sites worth hand-tuning.
