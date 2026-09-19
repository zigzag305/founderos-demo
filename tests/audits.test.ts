import { afterEach, describe, expect, test } from 'vitest';
import { openDb, type FounderDb } from '@/lib/db';
import { seedDatabase } from '@/lib/seed';
import { intakeToAudit, type DossierIntake } from '@/lib/audit-import';
import type { Audit, AuditFinding } from '@/lib/schemas';

let db: FounderDb;

afterEach(() => {
  db?.close();
});

const audit = (over: Partial<Audit> = {}): Audit => ({
  id: 'aud-1',
  brand: 'Acme Plumbing',
  slug: 'acme-plumbing',
  site: 'https://acmeplumbing.example',
  stage: 'captured',
  capturedAt: '2026-09-19',
  pagesCaptured: 9,
  competitors: ['https://rival.example'],
  needsHuman: ['target_audience_detail'],
  engagementId: null,
  ...over,
});

const finding = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  id: 'f-1',
  auditId: 'aud-1',
  kind: 'pricing',
  label: '£89',
  detail: 'Callout fee published on the pricing page',
  sourceUrl: 'https://acmeplumbing.example/pricing',
  ...over,
});

// --- persistence ----------------------------------------------------------

describe('audits repo', () => {
  test('starts empty', () => {
    db = openDb(':memory:');
    expect(db.audits.all()).toEqual([]);
  });

  test('round-trips an audit including its array columns', () => {
    db = openDb(':memory:');
    db.audits.insert(audit());
    const [row] = db.audits.all();
    expect(row.competitors).toEqual(['https://rival.example']);
    expect(row.needsHuman).toEqual(['target_audience_detail']);
    expect(row.engagementId).toBeNull();
  });

  test('insert is idempotent by id, so re-importing a dossier does not duplicate', () => {
    db = openDb(':memory:');
    db.audits.insert(audit());
    db.audits.insert(audit({ stage: 'strategy' }));
    expect(db.audits.all()).toHaveLength(1);
    expect(db.audits.all()[0].stage).toBe('strategy');
  });

  test('byId returns the audit with its findings attached', () => {
    db = openDb(':memory:');
    db.audits.insert(audit());
    db.audits.insertFinding(finding());
    db.audits.insertFinding(finding({ id: 'f-2', kind: 'offer', label: 'Boiler repair' }));
    const found = db.audits.byId('aud-1');
    expect(found?.findings).toHaveLength(2);
    expect(found?.findings.map((f) => f.kind)).toEqual(['offer', 'pricing']);
  });

  test('byId returns null for an unknown id rather than throwing', () => {
    db = openDb(':memory:');
    expect(db.audits.byId('nope')).toBeNull();
  });

  test('bySlug finds the same audit the /audits/[slug] route asks for', () => {
    db = openDb(':memory:');
    db.audits.insert(audit());
    db.audits.insertFinding(finding());
    expect(db.audits.bySlug('acme-plumbing')?.id).toBe('aud-1');
    expect(db.audits.bySlug('acme-plumbing')?.findings).toHaveLength(1);
    expect(db.audits.bySlug('nope')).toBeNull();
  });

  test('every finding keeps the URL it was read from', () => {
    db = openDb(':memory:');
    db.audits.insert(audit());
    db.audits.insertFinding(finding());
    expect(db.audits.byId('aud-1')?.findings[0].sourceUrl).toBe(
      'https://acmeplumbing.example/pricing',
    );
  });

  test('deleting an audit takes its findings with it', () => {
    db = openDb(':memory:');
    db.audits.insert(audit());
    db.audits.insertFinding(finding());
    db.audits.deleteWhereIdNotIn(['other']);
    expect(db.audits.all()).toEqual([]);
    expect(db.audits.findings('aud-1')).toEqual([]);
  });

  test('rejects an audit whose stage is not a known stage', () => {
    db = openDb(':memory:');
    expect(() => db.audits.insert(audit({ stage: 'invoiced' as Audit['stage'] }))).toThrow();
  });

  test('orders newest capture first, so the live work is at the top', () => {
    db = openDb(':memory:');
    db.audits.insert(audit({ id: 'old', capturedAt: '2026-01-01' }));
    db.audits.insert(audit({ id: 'new', capturedAt: '2026-09-01' }));
    expect(db.audits.all().map((a) => a.id)).toEqual(['new', 'old']);
  });
});

// --- the bridge from audit-machine ---------------------------------------

const intake: DossierIntake = {
  brand_name: 'acme-plumbing',
  site: 'https://acmeplumbing.example',
  captured: '2026-09-19',
  elevator_pitch: { value: 'Emergency plumbers in Leeds', source: 'https://acmeplumbing.example/' },
  offers: {
    value: ['Boiler repair', 'Drain unblocking'],
    source: ['https://acmeplumbing.example/services'],
  },
  pricing_signals: { value: ['£89', '£140'], source: ['https://acmeplumbing.example/pricing'] },
  calls_to_action: { value: ['Book a same-day visit'], source: ['https://acmeplumbing.example/'] },
  channels_observed: { value: ['instagram'], source: ['https://acmeplumbing.example/'] },
  contact: { emails: ['hello@acme.example'], phones: [] },
  competitors: ['https://rival.example'],
  pages_captured: 9,
  needs_human: ['target_audience_detail', 'pricing_not_public'],
};

describe('intakeToAudit', () => {
  test('turns a dossier intake into one audit plus a finding per signal', () => {
    const { audit: a, findings } = intakeToAudit(intake);
    expect(a.slug).toBe('acme-plumbing');
    expect(a.pagesCaptured).toBe(9);
    expect(a.stage).toBe('captured');
    // 2 offers + 2 prices + 1 cta + 1 channel
    expect(findings).toHaveLength(6);
  });

  test('carries the source URL onto every finding', () => {
    const { findings } = intakeToAudit(intake);
    expect(findings.every((f) => f.sourceUrl.startsWith('https://'))).toBe(true);
    expect(findings.find((f) => f.label === '£89')?.sourceUrl).toBe(
      'https://acmeplumbing.example/pricing',
    );
  });

  test('keeps needs_human on the audit so the gaps stay visible', () => {
    const { audit: a } = intakeToAudit(intake);
    expect(a.needsHuman).toContain('pricing_not_public');
  });

  test('titles the brand from the slug when the crawl had no better name', () => {
    const { audit: a } = intakeToAudit(intake);
    expect(a.brand).toBe('Acme Plumbing');
  });

  test('produces stable ids, so re-importing updates instead of duplicating', () => {
    const first = intakeToAudit(intake);
    const second = intakeToAudit(intake);
    expect(second.audit.id).toBe(first.audit.id);
    expect(second.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id));
  });

  test('survives an intake where the crawl found nothing to report', () => {
    const empty: DossierIntake = {
      ...intake,
      offers: { value: [], source: [] },
      pricing_signals: { value: [], source: [] },
      calls_to_action: { value: [], source: [] },
      channels_observed: { value: [], source: [] },
    };
    const { audit: a, findings } = intakeToAudit(empty);
    expect(findings).toEqual([]);
    expect(a.site).toBe('https://acmeplumbing.example');
  });

  test('falls back to the site URL when a signal has no source page', () => {
    const noSource: DossierIntake = {
      ...intake,
      pricing_signals: { value: ['£89'], source: [] },
      offers: { value: [], source: [] },
      calls_to_action: { value: [], source: [] },
      channels_observed: { value: [], source: [] },
    };
    expect(intakeToAudit(noSource).findings[0].sourceUrl).toBe('https://acmeplumbing.example');
  });

  test('output validates against the repo, end to end', () => {
    db = openDb(':memory:');
    const { audit: a, findings } = intakeToAudit(intake);
    db.audits.insert(a);
    for (const f of findings) db.audits.insertFinding(f);
    expect(db.audits.byId(a.id)?.findings).toHaveLength(6);
  });
});

// --- seed contract --------------------------------------------------------

describe('seeded audits', () => {
  test('ship at least one audit per stage, so every state is visible on screen', () => {
    db = openDb(':memory:');
    seedDatabase(db);
    const stages = new Set(db.audits.all().map((a) => a.stage));
    expect(stages).toEqual(new Set(['captured', 'strategy', 'delivered']));
  });

  test('every seeded audit has findings, and every finding cites a source', () => {
    db = openDb(':memory:');
    seedDatabase(db);
    for (const a of db.audits.all()) {
      const withFindings = db.audits.byId(a.id);
      expect(withFindings?.findings.length, `${a.id} has no findings`).toBeGreaterThan(0);
      for (const f of withFindings!.findings) {
        expect(f.sourceUrl, `${f.id} cites no source`).toMatch(/^https?:\/\//);
      }
    }
  });

  test('re-seeding is idempotent', () => {
    db = openDb(':memory:');
    seedDatabase(db);
    const before = db.audits.all().length;
    seedDatabase(db);
    expect(db.audits.all()).toHaveLength(before);
  });

  test('a delivered audit is linked to the engagement that produced it', () => {
    db = openDb(':memory:');
    seedDatabase(db);
    const delivered = db.audits.all().find((a) => a.stage === 'delivered');
    expect(delivered?.engagementId).toBeTruthy();
  });
});
