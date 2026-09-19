/**
 * The bridge from `audit-machine/dossier.py` into the audits repo.
 *
 * `dossier.py` writes an `intake.json` whose every signal is a `{ value,
 * source }` pair — the crawler records where it read something so a claim can
 * be checked in one click. This module preserves that pairing: one finding per
 * value, each carrying its source URL, and nothing invented along the way.
 *
 * Ids are derived from the brand and the value rather than generated, so
 * re-importing a re-crawl of the same site updates rows in place instead of
 * growing a second copy of the audit.
 */
import type { Audit, AuditFinding, AuditFindingKind } from '@/lib/schemas';

/** One `{ value, source }` block as dossier.py writes it. */
type Signal = { value: string[]; source: string[] };

export type DossierIntake = {
  brand_name: string;
  site: string;
  captured: string;
  elevator_pitch: { value: string; source: string };
  offers: Signal;
  pricing_signals: Signal;
  calls_to_action: Signal;
  channels_observed: Signal;
  contact: { emails: string[]; phones: string[] };
  competitors: string[];
  pages_captured: number;
  needs_human: string[];
};

/** acme-plumbing → Acme Plumbing. The crawl rarely finds a styled brand name. */
function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Stable, readable, and safe to put in a URL. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const KINDS: { key: keyof DossierIntake; kind: AuditFindingKind; detail: string }[] = [
  { key: 'offers', kind: 'offer', detail: 'Named as an offer on the site' },
  { key: 'pricing_signals', kind: 'pricing', detail: 'Price published publicly' },
  { key: 'calls_to_action', kind: 'cta', detail: 'Call to action in use' },
  { key: 'channels_observed', kind: 'channel', detail: 'Channel the site links to' },
];

export function intakeToAudit(intake: DossierIntake): {
  audit: Audit;
  findings: AuditFinding[];
} {
  const auditId = `aud-${slugify(intake.brand_name)}`;

  const audit: Audit = {
    id: auditId,
    brand: titleFromSlug(intake.brand_name),
    slug: slugify(intake.brand_name),
    site: intake.site,
    // A fresh import has only been crawled. The strategy and delivery stages
    // are set by whoever runs the engagement, never guessed from a crawl.
    stage: 'captured',
    capturedAt: intake.captured,
    pagesCaptured: intake.pages_captured,
    competitors: intake.competitors,
    needsHuman: intake.needs_human,
    engagementId: null,
  };

  const findings: AuditFinding[] = [];
  for (const { key, kind, detail } of KINDS) {
    const signal = intake[key] as Signal;
    for (const value of signal.value) {
      findings.push({
        id: `${auditId}-${kind}-${slugify(value)}`,
        auditId,
        kind,
        label: value,
        detail,
        // Prefer the page the signal was read from; fall back to the site so a
        // finding is never stored without somewhere to check it.
        sourceUrl: signal.source[0] ?? intake.site,
      });
    }
  }

  return { audit, findings };
}
