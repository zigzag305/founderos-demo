import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';

export const dynamic = 'force-dynamic';

/** `id` is the audit's slug, matching the /audits/[id] page route. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const audit = db.audits.bySlug(params.id);
  if (!audit) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ audit });
}
