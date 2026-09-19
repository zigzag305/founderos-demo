'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Loader2 } from 'lucide-react';
import type { AgentRun } from '@/lib/schemas';

/**
 * Fires POST /api/agents/[id]/run and shows what came back.
 *
 * A run does real work against a live system, so the result is reported as it
 * arrives — including failures, in full. The agent's own summary is the
 * message; this component never substitutes a cheerful one of its own.
 */
export function AgentRunButton({
  agentId,
  agentName,
  lastRun,
}: {
  agentId: string;
  agentName: string;
  lastRun?: AgentRun;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; summary: string } | null>(null);

  // Before the first click, show the run already on record so the panel is
  // never empty when there is something true to say.
  const shown = result ?? (lastRun ? { ok: lastRun.ok, summary: lastRun.summary } : null);

  async function run() {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/run`, { method: 'POST' });
      const body = (await res.json()) as { run?: AgentRun; error?: string };
      if (!res.ok || !body.run) {
        setResult({ ok: false, summary: body.error ?? `run failed (${res.status})` });
      } else {
        setResult({ ok: body.run.ok, summary: body.run.summary });
        // The run is persisted to agent_runs; refresh so the rest of the page
        // (activity feed, last-run state) catches up with it.
        router.refresh();
      }
    } catch (err) {
      setResult({ ok: false, summary: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={run}
        disabled={running}
        aria-label={`Run ${agentName}`}
        className="flex w-full items-center justify-center gap-1.5 border border-os-border bg-os-bg px-2.5 py-[7px] font-mono text-[10px] uppercase tracking-[0.18em] text-os-muted transition-colors hover:border-os-border-strong hover:text-os-text disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : (
          <Play className="h-3 w-3" aria-hidden />
        )}
        {running ? 'Running' : 'Run'}
      </button>

      {shown && (
        <div
          role="status"
          aria-live="polite"
          className="mt-1.5 flex items-baseline gap-1.5 font-mono text-[10px] leading-snug text-os-dim"
        >
          <span className={`shrink-0 font-bold ${shown.ok ? 'text-os-ok' : 'text-os-err'}`}>
            {shown.ok ? 'OK' : 'FAIL'}
          </span>
          {/* Wraps rather than truncates: a failure's summary carries the
              setup command that fixes it, and a clipped command is useless. */}
          <span className="min-w-0 break-words">{shown.summary}</span>
        </div>
      )}
    </div>
  );
}
