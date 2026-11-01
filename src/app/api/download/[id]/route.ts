import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import {
  cancelServerDownload,
  getServerDownload,
  pauseServerDownload,
  removeServerDownload,
  resumeServerDownload,
  retryServerDownload,
} from '@/lib/server-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  const task = getServerDownload(id);
  if (!task) return jsonError('任务不存在', 404);
  return NextResponse.json({ task });
}

/** DELETE：取消并移除记录（不删已落盘文件） */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const onlyCancel = sp.get('cancel') === '1';
  if (onlyCancel) {
    if (!cancelServerDownload(id)) return jsonError('任务不存在', 404);
    return NextResponse.json({ ok: true, task: getServerDownload(id) });
  }
  if (!removeServerDownload(id)) return jsonError('任务不存在', 404);
  return NextResponse.json({ ok: true });
}

/** POST：?action=pause|resume|retry（默认 retry） */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get('action') || 'retry';

  if (action === 'pause') {
    if (!pauseServerDownload(id)) return jsonError('无法暂停（仅下载中可暂停）', 400);
    return NextResponse.json({ task: getServerDownload(id) });
  }
  if (action === 'resume') {
    if (!resumeServerDownload(id)) return jsonError('无法继续', 400);
    return NextResponse.json({ task: getServerDownload(id) });
  }

  const task = retryServerDownload(id);
  if (!task) return jsonError('任务不存在', 404);
  return NextResponse.json({ task });
}
