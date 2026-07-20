/**
 * Generate a tailored application letter per listing, using Gemini.
 * Customises to the listing's real move-in date and neighbourhood, in English,
 * with NO em dashes. Falls back to profile.responseLetterOverride on any error.
 *
 * Test:  npx tsx src/generate-letter.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(readFileSync(join(__dirname, '..', 'profile.json'), 'utf8'));

export interface ListingInfo {
  address?: string;
  neighborhood?: string;
  city?: string;
  priceEur?: number;
  availableFrom?: string; // e.g. "1 August 2026" or "per direct"
  description?: string; // the full listing description text
  sourceSite?: string;
}

// Stable facts about the applicants, drawn from the profile.
function applicantFacts(): string {
  const a = profile.applicants || [];
  const a0 = a[0] || {}; const a1 = a[1] || {};
  const f = profile.financials || {}; const g = f.guarantor || {};
  const t = profile.currentTenancy || {};
  const hobbies = [a0.hobby ? `${a0.firstName}: ${a0.hobby}` : '', a1.hobby ? `${a1.firstName}: ${a1.hobby}` : ''].filter(Boolean).join('; ');
  return [
    `Applicants: ${a0.firstName} ${a0.lastName} (${a0.nationality}) and ${a1.firstName} ${a1.lastName} (${a1.nationality}), a couple in their mid-twenties.`,
    `${a1.firstName} is a ${a1.occupation}${a1.institution ? ` at ${a1.institution}` : ''}. ${a0.firstName} is a ${a0.occupation}${a0.institution ? ` at ${a0.institution}` : ''}.`,
    `They have lived in The Hague for ${t.yearsThere || 'two'} years, currently in ${profile.currentNeighbourhood || 'The Hague'} at ${t.address || 'their current home'}.`,
    hobbies ? `Hobbies: ${hobbies}.` : '',
    'Lifestyle: quiet, tidy, non-smokers, no pets, no children. Excellent reference from their current landlord.',
    `Finances: ${a0.firstName} earns around EUR ${f.grossMonthlyIncomeEur || 4000} per month, plus a well-paid guarantor (${g.relation || 'a family guarantor'}, ${g.basis || 'stable income'}).`,
    "Documents ready: IDs, enrolment letters, current landlord's reference, and full guarantor documentation.",
  ].filter(Boolean).join('\n');
}

const stripEmDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ', ').replace(/ ,/g, ',').replace(/,,/g, ',');

// A letter that fails any of these would hurt the application: leftover
// [placeholders], a missing/mangled sign-off, or a wildly off length.
function letterProblems(letter: string, signOff: string): string | null {
  if (/[\[\]{}<>]/.test(letter)) return 'contains placeholder brackets';
  const words = letter.split(/\s+/).length;
  if (words < 90 || words > 260) return `bad length (${words} words)`;
  if (!letter.includes(signOff)) return 'missing sign-off';
  if (!/^dear/i.test(letter.trim())) return 'missing salutation';
  return null;
}

export async function generateLetter(listing: ListingInfo): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return stripEmDashes((profile.responseLetterOverride || '').trim());

  const ap = profile.applicants || [];
  const signOff = `${ap[1]?.firstName || ''} ${ap[1]?.lastName || ''} and ${ap[0]?.firstName || ''} ${ap[0]?.lastName || ''}`.replace(/\s+/g, ' ').trim();

  const prompt = `Write a short rental viewing-application letter for a couple applying for an apartment in the Netherlands.

STRICT RULES:
- English only.
- NEVER use em dashes or en dashes (— or –). Use commas, periods, or parentheses instead.
- 130 to 190 words. Warm, sincere, specific, professional. Not over-the-top or gushing.
- Do not invent facts that are not provided below. Do NOT state specific ages; you may say "in our mid-twenties".
- Begin with the salutation "Dear sir or madam,". NEVER use placeholder brackets like [Name] or [Address].
- The named guarantor IS the guarantor (do not say they "provide" one).
- End exactly with: "Kind regards, ${signOff}"

APPLICANTS:
${applicantFacts()}

THIS LISTING:
- Address: ${listing.address || 'n/a'}${listing.neighborhood ? `, neighbourhood: ${listing.neighborhood}` : ''}, ${listing.city || 'The Hague'}
- Rent: ${listing.priceEur ? `EUR ${listing.priceEur}/month` : 'n/a'}
- Available from: ${listing.availableFrom || 'not stated'}
- Description: ${listing.description ? listing.description.slice(0, 900) : 'not provided'}

CUSTOMISE:
- Move-in timing: if an available-from date is given, say that timing suits us well and reference it naturally. NEVER mention a different or conflicting date. If no date is given, say we are flexible on the move-in date.
- Neighbourhood: if this listing's neighbourhood is very close to where the applicants currently live (their current area is stated in the applicant facts above), express genuine, specific enthusiasm for staying in an area they already know and love. Otherwise keep neighbourhood mentions light and honest.
- Optionally reference one or two concrete details from the description if they genuinely fit.

Return ONLY the letter text, no preamble.`;

  // Up to 2 attempts; a letter failing the quality checks never goes out.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6 } }),
        },
      );
      const j: any = await res.json();
      const text: string | undefined = j?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('empty response: ' + JSON.stringify(j).slice(0, 200));
      const letter = stripEmDashes(text.trim());
      const problem = letterProblems(letter, signOff);
      if (!problem) return letter;
      console.error(`letter QC failed (attempt ${attempt}): ${problem}`);
    } catch (e) {
      console.error(`letter generation failed (attempt ${attempt}):`, (e as Error).message);
    }
  }
  return stripEmDashes((profile.responseLetterOverride || '').trim());
}

// ── test: generate for a sample Den Haag listing ──
if (import.meta.url === `file://${process.argv[1]}`) {
  generateLetter({
    address: 'Voorbeeldstraat 1',
    neighborhood: 'Centrum',
    city: 'Den Haag',
    priceEur: 1500,
    availableFrom: '1 September 2026',
    description: 'A furnished apartment in Den Haag, close to the city centre, shops and cafes.',
  }).then((letter) => {
    console.log('\n===== GENERATED LETTER =====\n');
    console.log(letter);
    console.log('\n===== end (' + letter.split(/\s+/).length + ' words, em dashes: ' + (/[—–]/.test(letter) ? 'YES ✗' : 'none ✓') + ') =====');
    process.exit(0);
  });
}
