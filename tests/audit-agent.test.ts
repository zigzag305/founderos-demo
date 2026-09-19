import { afterEach, describe, expect, test, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * The audit agent and its Run button. The crawler itself is Python and may not
 * be installed, so the contract under test is that the agent says so honestly
 * rather than failing at click time — and that a run against a real board
 * still reports true numbers either way.
 */

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function freshDb(): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), 'founder-os-audit-agent-')), 'test.db');
  vi.stubEnv('FOUNDER_OS_DB', p);
  return p;
}

describe('audit agent', () => {
  test('is on the roster with a real run()', async () => {
    const { realAgents } = await import('@/lib/agents/real');
    const agent = realAgents.find((a) => a.id === 'audit-agent');
    expect(agent).toBeDefined();
    expect(typeof agent!.run).toBe('function');
    expect(typeof agent!.respond).toBe('function');
  });

  test('run() reports the board: counts, work waiting, and open gaps', async () => {
    freshDb();
    const { realAgents } = await import('@/lib/agents/real');
    const agent = realAgents.find((a) => a.id === 'audit-agent')!;
    const result = await agent.run();
    const data = result.data as { audits: number; captured: number; openGaps: number };
    // The seeded board ships three audits, one per stage.
    expect(data.audits).toBe(3);
    expect(data.captured).toBe(1);
    expect(data.openGaps).toBeGreaterThan(0);
    expect(result.summary).toContain('open gap');
  });

  test('run() reports the crawler as not configured rather than pretending', async () => {
    // Point the interpreter lookup at something that cannot import crawl4ai.
    vi.stubEnv('AUDIT_PYTHON', path.join(tmpdir(), 'founder-os-no-python'));
    freshDb();
    vi.doMock('@/lib/connectors/audit-machine', async (orig) => ({
      ...(await orig<typeof import('@/lib/connectors/audit-machine')>()),
      auditMachineStatus: async () => ({
        id: 'audit-machine',
        name: 'Audit Machine',
        kind: 'local' as const,
        state: 'not_configured' as const,
        detail: 'crawl4ai not importable — run: cd audit-machine && python3 -m venv .venv',
      }),
    }));
    const { realAgents } = await import('@/lib/agents/real');
    const agent = realAgents.find((a) => a.id === 'audit-agent')!;
    const result = await agent.run();
    expect(result.ok).toBe(false);
    // The failure must carry the command that fixes it, not just "failed".
    expect(result.summary).toContain('venv');
  });

  test('run() still reports honest board numbers when the crawler is missing', async () => {
    freshDb();
    vi.doMock('@/lib/connectors/audit-machine', async (orig) => ({
      ...(await orig<typeof import('@/lib/connectors/audit-machine')>()),
      auditMachineStatus: async () => ({
        id: 'audit-machine',
        name: 'Audit Machine',
        kind: 'local' as const,
        state: 'not_configured' as const,
        detail: 'not installed',
      }),
    }));
    const { realAgents } = await import('@/lib/agents/real');
    const result = await realAgents.find((a) => a.id === 'audit-agent')!.run();
    expect((result.data as { audits: number }).audits).toBe(3);
  });

  test('respond() asks for a URL instead of guessing one', async () => {
    freshDb();
    const { realAgents } = await import('@/lib/agents/real');
    const agent = realAgents.find((a) => a.id === 'audit-agent')!;
    const result = await agent.respond!('go audit someone');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('URL');
  });

  test('respond() files a crawl on the board and links where to read it', async () => {
    freshDb();
    // Stand in for the Python crawler: write the intake dossier.py would write.
    vi.doMock('@/lib/connectors/audit-machine', async (orig) => {
      const fs = await import('node:fs');
      const dir = mkdtempSync(path.join(tmpdir(), 'founder-os-crawl-'));
      const intakePath = path.join(dir, 'intake.json');
      fs.writeFileSync(
        intakePath,
        JSON.stringify({
          brand_name: 'harbour-legal',
          site: 'https://harbour-legal.example',
          captured: '2026-09-19',
          elevator_pitch: { value: 'Commercial law', source: 'https://harbour-legal.example/' },
          offers: { value: ['Employment law'], source: ['https://harbour-legal.example/services'] },
          pricing_signals: { value: [], source: [] },
          calls_to_action: { value: [], source: [] },
          channels_observed: { value: [], source: [] },
          contact: { emails: [], phones: [] },
          competitors: [],
          pages_captured: 4,
          needs_human: ['pricing_not_public'],
        }),
      );
      return {
        ...(await orig<typeof import('@/lib/connectors/audit-machine')>()),
        crawlSite: async () => ({ ok: true as const, intakePath, outDir: dir }),
      };
    });

    const { realAgents } = await import('@/lib/agents/real');
    const agent = realAgents.find((a) => a.id === 'audit-agent')!;
    const result = await agent.respond!('audit https://harbour-legal.example please');
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('/audits/harbour-legal');

    const { getDb } = await import('@/lib/data');
    const filed = getDb().audits.bySlug('harbour-legal');
    // harbour-legal is also seeded, with four findings. A re-crawl is a
    // snapshot, so the board must now show only what this crawl found —
    // otherwise it keeps asserting services the site may have dropped.
    expect(filed?.findings).toHaveLength(1);
    expect(filed?.findings[0].label).toBe('Employment law');
    expect(filed?.needsHuman).toContain('pricing_not_public');
  });

  test('respond() surfaces a crawl failure instead of filing an empty audit', async () => {
    freshDb();
    vi.doMock('@/lib/connectors/audit-machine', async (orig) => ({
      ...(await orig<typeof import('@/lib/connectors/audit-machine')>()),
      crawlSite: async () => ({ ok: false as const, error: 'net::ERR_NAME_NOT_RESOLVED' }),
    }));
    const { realAgents } = await import('@/lib/agents/real');
    const agent = realAgents.find((a) => a.id === 'audit-agent')!;
    const result = await agent.respond!('audit https://does-not-exist.example');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('ERR_NAME_NOT_RESOLVED');

    const { getDb } = await import('@/lib/data');
    expect(getDb().audits.bySlug('does-not-exist')).toBeNull();
  });
});

describe('audit-machine connector', () => {
  test('reports not_configured when no interpreter can import crawl4ai', async () => {
    vi.stubEnv('AUDIT_PYTHON', path.join(tmpdir(), 'founder-os-definitely-not-python'));
    const { auditMachineStatus } = await import('@/lib/connectors/audit-machine');
    const status = await auditMachineStatus();
    // Either outcome is honest — what must never happen is a fake "connected".
    expect(['connected', 'not_configured']).toContain(status.state);
    if (status.state === 'not_configured') expect(status.detail).toContain('crawl4ai');
  }, 30_000);

  test('never invents a connected state without naming what proved it', async () => {
    const { auditMachineStatus } = await import('@/lib/connectors/audit-machine');
    const status = await auditMachineStatus();
    if (status.state === 'connected') expect(status.meta?.interpreter).toBeTruthy();
  }, 30_000);
});

describe('audit agent — failed crawls', () => {
  test('does not file an audit when the crawl reached no pages', async () => {
    // dossier.py exits 0 even when every page failed, so this is the shape a
    // dead or unreachable host actually produces.
    freshDb();
    vi.doMock('@/lib/connectors/audit-machine', async (orig) => {
      const fs = await import('node:fs');
      const dir = mkdtempSync(path.join(tmpdir(), 'founder-os-deadcrawl-'));
      const intakePath = path.join(dir, 'intake.json');
      fs.writeFileSync(
        intakePath,
        JSON.stringify({
          brand_name: 'ghost-co',
          site: 'https://ghost-co.example',
          captured: '2026-09-19',
          elevator_pitch: { value: '', source: 'https://ghost-co.example' },
          offers: { value: [], source: [] },
          pricing_signals: { value: [], source: [] },
          calls_to_action: { value: [], source: [] },
          channels_observed: { value: [], source: [] },
          contact: { emails: [], phones: [] },
          competitors: [],
          pages_captured: 0,
          needs_human: ['elevator_pitch'],
        }),
      );
      return {
        ...(await orig<typeof import('@/lib/connectors/audit-machine')>()),
        crawlSite: async () => ({ ok: true as const, intakePath, outDir: dir }),
      };
    });

    const { realAgents } = await import('@/lib/agents/real');
    const result = await realAgents
      .find((a) => a.id === 'audit-agent')!
      .respond!('audit https://ghost-co.example');

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('no pages');

    const { getDb } = await import('@/lib/data');
    expect(getDb().audits.bySlug('ghost-co')).toBeNull();
  });
});
