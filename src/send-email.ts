/**
 * Send application emails as the user via Gmail SMTP (same "Homemaker" app
 * password used for IMAP). For agency listings that are "email the agent"
 * rather than a web form.
 *
 * Live self-test:  npx tsx src/send-email.ts
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const user = process.env.GMAIL_USER!;
const pass = process.env.GMAIL_APP_PASSWORD!;
let fromName = 'Applicant';
try {
  const p = JSON.parse(readFileSync(join(__dirname, '..', 'profile.json'), 'utf8'));
  fromName = `${p.applicants?.[0]?.firstName || ''} ${p.applicants?.[0]?.lastName || ''}`.trim() || 'Applicant';
} catch { /* profile not present */ }

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; path: string }[];
}

export function transport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

export async function sendApplicationEmail(mail: OutgoingEmail) {
  return transport().sendMail({ from: `${fromName} <${user}>`, ...mail });
}

// ── live self-test: sends a real email to your own inbox with 2 docs attached ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const docs = join(__dirname, '..', 'documents');
  sendApplicationEmail({
    to: user,
    subject: '[Homemaker] SMTP live test ✅',
    text:
      'Live test from the Stekkies auto-apply tool.\n\n' +
      'If you can read this with the two PDFs attached, the tool can send application ' +
      'emails as you (with documents) to email-only agency listings.\n\n— Homemaker',
    attachments: [
      { filename: 'Letter of Enrollment.pdf', path: join(docs, 'Mateo 2026 Letter of Enrollment.pdf') },
      { filename: 'UVA Offer accepted.pdf', path: join(docs, 'UVA Offer accepted.pdf') },
    ],
  })
    .then((info) => { console.log('✅ sent. accepted:', info.accepted, 'messageId:', info.messageId); process.exit(0); })
    .catch((e) => { console.error('✗ send failed:', e); process.exit(1); });
}
