import Link from 'next/link';
import { getDb } from '@/lib/data';
import { PageHeader } from '@/components/PageHeader';
import { Badge, SectionHead, type BadgeTone } from '@/components/terminal';
import type { AuditStage } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

const STAGE: Record<AuditStage, { tone: BadgeTone; ghost: boolean; label: string }> = {
  captured: { tone: 'default', ghost: true, label: 'Captured' },
  strategy: { tone: 'warn', ghost: false, label: 'Strategy' },
  delivered: { tone: 'ok', ghost: false, label: 'Delivered' },
};

// Stage order is the pipeline order, not alphabetical: what needs attention
// first sits at the top of the board.
const STAGE_ORDER: AuditStage[] = ['captured', 'strategy', 'delivered'];

export default function AuditsPage() {
  const db = getDb();
  const audits = db.audits.all();
  const byStage = STAGE_ORDER.map((stage) => ({
    stage,
    rows: audits.filter((a) => a.stage === stage),
  }));

  return (
    <div>
      <PageHeader eyebrow="client audits" title="Audits" />

      {audits.length === 0 && (
        <p className="text-[13px] text-os-muted">
          No audits yet. Run <span className="font-mono text-os-text">audit-machine/dossier.py</span>{' '}
          against a prospect, then import the intake it writes.
        </p>
      )}

      {byStage.map(({ stage, rows }) =>
        rows.length === 0 ? null : (
          <section key={stage} className="mb-9">
            <SectionHead label={STAGE[stage].label} count={rows.length} />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((a) => {
                const findings = db.audits.byId(a.id)?.findings ?? [];
                const prices = findings.filter((f) => f.kind === 'pricing');
                return (
                  <Link
                    key={a.id}
                    href={`/audits/${a.slug}`}
                    className="block border border-os-border bg-os-surface px-[17px] py-[15px] transition-colors hover:border-os-border-strong"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <h2 className="min-w-0 truncate text-sm font-bold">{a.brand}</h2>
                      <Badge tone={STAGE[a.stage].tone} ghost={STAGE[a.stage].ghost}>
                        {STAGE[a.stage].label}
                      </Badge>
                    </div>

                    <div className="truncate font-mono text-[10.5px] text-os-dim">{a.site}</div>

                    <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">
                      <div>
                        <dt>Pages</dt>
                        <dd className="mt-0.5 text-[13px] tracking-normal text-os-text">
                          {a.pagesCaptured}
                        </dd>
                      </div>
                      <div>
                        <dt>Findings</dt>
                        <dd className="mt-0.5 text-[13px] tracking-normal text-os-text">
                          {findings.length}
                        </dd>
                      </div>
                      <div>
                        <dt>Gaps</dt>
                        {/* Gaps are warn-coloured, never hidden: an unanswered
                            question is the thing most likely to sink the work. */}
                        <dd
                          className={`mt-0.5 text-[13px] tracking-normal ${
                            a.needsHuman.length ? 'text-os-warn' : 'text-os-text'
                          }`}
                        >
                          {a.needsHuman.length}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-3 border-t border-os-border pt-2.5 text-[11.5px] text-os-muted">
                      {prices.length > 0 ? (
                        <>Public pricing: {prices.map((p) => p.label).join(', ')}</>
                      ) : (
                        <span className="text-os-warn">No public pricing</span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
