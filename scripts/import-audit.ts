/**
 * Closes the Audit Machine chain: audit-machine → this console.
 *
 *   npm run audit:import -- audit-machine/out/acme-plumbing/2026-09-19/intake.json
 *
 * Reads the `intake.json` that `dossier.py` writes and upserts it into the
 * audits repo. Ids are derived from the brand, so re-running it after a
 * re-crawl updates the same audit rather than creating a second one.
 */
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../lib/db';
import { intakeToAudit, type DossierIntake } from '../lib/audit-import';

const [, , intakePath, stageArg] = process.argv;

if (!intakePath) {
  console.error('usage: npm run audit:import -- <path/to/intake.json> [stage]');
  console.error('       stage is one of captured | strategy | delivered (default: captured)');
  process.exit(1);
}

const resolved = path.resolve(intakePath);
if (!fs.existsSync(resolved)) {
  console.error(`No intake file at ${resolved}`);
  process.exit(1);
}

let intake: DossierIntake;
try {
  intake = JSON.parse(fs.readFileSync(resolved, 'utf8')) as DossierIntake;
} catch (err) {
  console.error(`${resolved} is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}

const { audit, findings } = intakeToAudit(intake);
// The crawl only ever proves "captured". A later stage is the operator
// asserting that an engagement ran, so it has to be passed in deliberately.
if (stageArg) {
  if (!['captured', 'strategy', 'delivered'].includes(stageArg)) {
    console.error(`Unknown stage "${stageArg}" — use captured, strategy or delivered.`);
    process.exit(1);
  }
  audit.stage = stageArg as typeof audit.stage;
}

const dbPath = process.env.FOUNDER_OS_DB ?? path.join(process.cwd(), 'data', 'founder-os.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

// Schema parse happens inside the repo, so a malformed intake fails here
// rather than surfacing as a broken page later.
db.audits.insert(audit);
// Replace, don't append: a re-crawl must drop findings the site lost.
db.audits.replaceFindings(audit.id, findings);
db.close();

console.log(`Imported ${audit.brand} (${audit.stage}) into ${dbPath}`);
console.log(`  findings:   ${findings.length}`);
console.log(`  open gaps:  ${audit.needsHuman.length}`);
console.log(`  view:       /audits/${audit.slug}`);
