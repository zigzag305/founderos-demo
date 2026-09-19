import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/data';
import { PageHeader } from '@/components/PageHeader';
import { Badge, SectionHead, type BadgeTone } from '@/components/terminal';
import type { AuditFindingKind, AuditStage } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

const STAGE: Record<AuditStage, { tone: BadgeTone; ghost: boolean; label: string }> = {
  captured: { tone: 'default', ghost: true, label: 'Captured' },
  strategy: { tone: 'warn', ghost: false, label: 'Strategy' },
  delivered: { tone: 'ok', ghost: false, label: 'Delivered' },
};

const KIND_LABEL: Record<AuditFindingKind, string> = {
  offer: 'Offers',
  pricing: 'Public pricing',
  cta: 'Calls to action',
  channel: 'Channels',
};

const KIND_ORDER: AuditFindingKind[] = ['offer', 'pricing', 'cta', 'channel'];

/** needs_human keys arrive snake_cased from dossier.py. */
function humanise(key: string): string {
  const s = key.replace(/_/g, ' ');
  return s[0].toUpperCase() + s.slice(1);
}

export default function AuditDetailPage({ params }: { params: { id: string } }) {
  const db = getDb();
  const audit = db.audits.bySlug(params.id);
  if (!audit) notFound();

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    rows: audit.findings.filter((f) => f.kind === kind),
  }));

  return (
    <div>
      <PageHeader
        eyebrow={`audit · ${audit.capturedAt}`}
        title={audit.brand}
        right={
          <Badge tone={STAGE[audit.stage].tone} ghost={STAGE[audit.stage].ghost}>
            {STAGE[audit.stage].label}
          </Badge>
        }
      />

      <div className="mb-7 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11px] text-os-dim">
        <Link href="/audits" className="text-os-accent hover:underline">
          ← All audits
        </Link>
        <span className="break-all">{audit.site}</span>
        <span>{audit.pagesCaptured} pages captured</span>
        {audit.engagementId && <span>engagement: {audit.engagementId}</span>}
      </div>

      {/* Gaps lead. A strategy built on an unanswered question is confidently
          wrong, so the board shows what is missing before what was found. */}
      {audit.needsHuman.length > 0 && (
        <section className="mb-9">
          <SectionHead label="The website cannot answer these" count={audit.needsHuman.length} />
          <ul className="flex flex-col gap-1.5 border border-os-warn/40 bg-os-surface px-[17px] py-[15px]">
            {audit.needsHuman.map((key) => (
              <li key={key} className="flex items-baseline gap-2.5 text-[13px]">
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 bg-os-warn" />
                {humanise(key)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {grouped.map(({ kind, rows }) =>
        rows.length === 0 ? null : (
          <section key={kind} className="mb-9">
            <SectionHead label={KIND_LABEL[kind]} count={rows.length} />
            <ul className="flex flex-col">
              {rows.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-os-border py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium">{f.label}</div>
                    <div className="text-[11.5px] text-os-muted">{f.detail}</div>
                  </div>
                  {/* Every claim links to the page it was read from — the
                      client can check it, and so can you before invoicing. */}
                  <a
                    href={f.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="shrink-0 break-all font-mono text-[10.5px] text-os-dim hover:text-os-accent"
                  >
                    {f.sourceUrl}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}

      {audit.competitors.length > 0 && (
        <section className="mb-9">
          <SectionHead label="Competitors crawled" count={audit.competitors.length} />
          <ul className="flex flex-col gap-1">
            {audit.competitors.map((c) => (
              <li key={c} className="break-all font-mono text-[11.5px] text-os-muted">
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
