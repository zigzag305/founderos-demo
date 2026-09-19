import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ConnectorStatus } from '@/lib/connectors/types';

/**
 * The audit-machine crawler, as a connector.
 *
 * `audit-machine/dossier.py` is Python and needs crawl4ai plus a Playwright
 * browser, none of which ship with this app. So this reports honestly what is
 * actually runnable rather than assuming: a missing interpreter or a missing
 * crawl4ai is `not_configured` with the command that fixes it, never a silent
 * failure at click time.
 */

const ROOT = path.join(process.cwd(), 'audit-machine');
const SCRIPT = path.join(ROOT, 'dossier.py');

/** Interpreters to try, best first. AUDIT_PYTHON wins when set. */
function candidates(): string[] {
  const venv = path.join(ROOT, '.venv', 'bin', 'python');
  return [process.env.AUDIT_PYTHON, venv, 'python3'].filter(Boolean) as string[];
}

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? String(err ?? '') }),
    );
  });
}

/** The first interpreter that can actually import crawl4ai, or null. */
export async function findInterpreter(): Promise<string | null> {
  for (const bin of candidates()) {
    const probe = await run(bin, ['-c', 'import crawl4ai'], 20_000);
    if (probe.ok) return bin;
  }
  return null;
}

export async function auditMachineStatus(): Promise<ConnectorStatus> {
  const base = { id: 'audit-machine', name: 'Audit Machine', kind: 'local' as const };

  if (!fs.existsSync(SCRIPT)) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'audit-machine/dossier.py not found in this checkout',
    };
  }

  const bin = await findInterpreter();
  if (!bin) {
    return {
      ...base,
      state: 'not_configured',
      detail:
        'crawl4ai not importable — run: cd audit-machine && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/crawl4ai-setup',
    };
  }

  return {
    ...base,
    state: 'connected',
    detail: `crawler ready (${path.basename(bin)})`,
    meta: { interpreter: bin },
  };
}

export type CrawlOutcome =
  | { ok: true; intakePath: string; outDir: string }
  | { ok: false; error: string };

/**
 * Run a real crawl. Returns where dossier.py wrote its intake so the caller
 * can import it; it deliberately does not parse the file itself, keeping the
 * JSON → repo mapping in one place (lib/audit-import.ts).
 */
export async function crawlSite(opts: {
  brand: string;
  site: string;
  competitors?: string[];
  maxPages?: number;
  timeoutMs?: number;
}): Promise<CrawlOutcome> {
  const bin = await findInterpreter();
  if (!bin) return { ok: false, error: 'crawl4ai is not installed — see /integrations for the command' };

  const outRoot = path.join(ROOT, 'out');
  const args = [
    SCRIPT,
    '--brand', opts.brand,
    '--site', opts.site,
    '--max-pages', String(opts.maxPages ?? 8),
    '--out', outRoot,
  ];
  for (const c of opts.competitors ?? []) args.push('--competitor', c);

  // A crawl walks several pages through a real browser, so it is slow by
  // nature; the ceiling stops a hung site holding the request open forever.
  const res = await run(bin, args, opts.timeoutMs ?? 240_000);
  if (!res.ok) {
    const tail = res.stderr.trim().split('\n').slice(-3).join(' · ');
    return { ok: false, error: tail || 'crawl failed' };
  }

  // dossier.py writes out/<brand>/<date>/; take the newest date directory
  // rather than recomputing today's, so a run that straddles midnight still
  // finds its own output.
  const brandDir = path.join(outRoot, opts.brand);
  if (!fs.existsSync(brandDir)) return { ok: false, error: 'crawl produced no output directory' };
  const dates = fs.readdirSync(brandDir).sort();
  const outDir = path.join(brandDir, dates[dates.length - 1]);
  const intakePath = path.join(outDir, 'intake.json');
  if (!fs.existsSync(intakePath)) return { ok: false, error: 'crawl wrote no intake.json' };

  return { ok: true, intakePath, outDir };
}
