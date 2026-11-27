// One-off backfill for migration 0004_email_envelope_from.
//
// Before 0004, emails.from_addr held the SMTP envelope sender (often a VERP bounce
// address such as 0106...@send.example.com). The migration copies it to
// envelope_from; this script re-parses each old row's stored raw headers and sets
// from_addr to the header From, matching what src/email/parser.ts now stores.
//
// Usage (run after the migration has been applied):
//   CLOUDFLARE_ACCOUNT_ID=<account> node scripts/backfill-header-from.mjs <d1-name> [--dry-run]
//
// Safe to re-run: it only touches rows whose from_addr still equals envelope_from.
import { execFileSync } from 'node:child_process';
import PostalMime from 'postal-mime';

const PAGE_SIZE = 50;
// `d1 execute --file` prints progress text instead of JSON, so updates go out as
// --command batches of this many statements.
const UPDATE_BATCH_SIZE = 50;
// Header blocks rarely exceed this; long ARC/DKIM chains stay well below it.
const HEADER_SLICE_CHARS = 32 * 1024;
// Mirrors EMAIL_ADDRESS_RE in src/email/forward.ts. The worker sources are
// extension-less TS imports, so this script cannot import them directly.
const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isValidAddress(value) {
  return value.length <= 254 && EMAIL_ADDRESS_RE.test(value);
}

// Same selection rule as firstValidAddress in src/email/reply.ts.
export function firstValidAddress(addresses) {
  if (!addresses) return '';
  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    const members = entry.address ? [entry] : (entry.group ?? []);
    for (const member of members) {
      const candidate = member.address?.trim() ?? '';
      if (isValidAddress(candidate)) return candidate;
    }
  }
  return '';
}

export async function headerFromAddress(rawHead) {
  const crlf = rawHead.indexOf('\r\n\r\n');
  const lf = rawHead.indexOf('\n\n');
  const ends = [crlf, lf].filter((index) => index !== -1);
  const headers = ends.length ? rawHead.slice(0, Math.min(...ends)) : rawHead;
  const parsed = await new PostalMime().parse(`${headers}\r\n\r\n`);
  return firstValidAddress(parsed.from);
}

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function d1(db, extraArgs) {
  const output = execFileSync(
    'pnpm',
    ['-s', 'wrangler', 'd1', 'execute', db, '--remote', '--json', '--yes', ...extraArgs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(output);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const db = args.find((arg) => !arg.startsWith('--'));
  if (!db) {
    console.error('用法：CLOUDFLARE_ACCOUNT_ID=<account> node scripts/backfill-header-from.mjs <d1-name> [--dry-run]');
    process.exit(1);
  }

  const updates = [];
  let scanned = 0;
  let lastId = 0;
  for (;;) {
    const [result] = d1(db, ['--command', `
      SELECT id, from_addr, substr(raw_body, 1, ${HEADER_SLICE_CHARS}) AS head
      FROM emails
      WHERE from_addr = envelope_from AND id > ${lastId}
      ORDER BY id LIMIT ${PAGE_SIZE}`]);
    const rows = result.results;
    if (!rows.length) break;
    for (const row of rows) {
      scanned += 1;
      const headerFrom = await headerFromAddress(row.head || '');
      if (headerFrom && headerFrom.toLowerCase() !== String(row.from_addr).toLowerCase()) {
        updates.push({ id: row.id, from: row.from_addr, to: headerFrom });
      }
    }
    lastId = rows[rows.length - 1].id;
  }

  console.log(`${db}: 扫描 ${scanned} 封，需要更新 ${updates.length} 封`);
  for (const update of updates.slice(0, 10)) {
    console.log(`  #${update.id}  ${update.from}  →  ${update.to}`);
  }
  if (updates.length > 10) console.log(`  ……另有 ${updates.length - 10} 封`);
  if (dryRun || !updates.length) return;

  for (let start = 0; start < updates.length; start += UPDATE_BATCH_SIZE) {
    const sql = updates
      .slice(start, start + UPDATE_BATCH_SIZE)
      .map(({ id, to }) => `UPDATE emails SET from_addr = ${sqlString(to)} WHERE id = ${Number(id)};`)
      .join('\n');
    d1(db, ['--command', sql]);
  }
  console.log(`${db}: 已更新 ${updates.length} 封`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
