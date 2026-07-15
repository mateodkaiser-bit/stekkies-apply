// Reads the backfill JSON output and prints an idempotent upsert for the tracker.
import { readFileSync } from 'node:fs';

const txt = readFileSync(process.argv[2], 'utf8');
const m = txt.match(/===ROWS_JSON_START===\s*([\s\S]*?)\s*===ROWS_JSON_END===/);
if (!m) throw new Error('no ROWS_JSON block found');
const rows = JSON.parse(m[1]);
const s = (v: any) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const n = (v: any) => (v == null ? 'null' : Number(v));
const vals = rows
  .map((r: any) =>
    `(${s(r.match_id)},${s(r.address)},${s(r.city)},${n(r.price_eur)},${n(r.bedrooms)},${n(r.surface_m2)},${s(r.source_site)},${s(r.source_url)},${s(r.match_url)},${r.paid_to_apply ? 'true' : 'false'},${s(r.status)})`,
  )
  .join(',\n');
console.log(
  `insert into stekkies.applications (match_id,address,city,price_eur,bedrooms,surface_m2,source_site,source_url,match_url,paid_to_apply,status) values\n${vals}\non conflict (match_id) do update set source_site=excluded.source_site, source_url=excluded.source_url, paid_to_apply=excluded.paid_to_apply, status=excluded.status, address=coalesce(excluded.address, stekkies.applications.address);`,
);
