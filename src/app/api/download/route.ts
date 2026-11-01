import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import {
  createServerDownload,
  getDownloadRoots,
  listServerDownloads,
  type MediaKind,
} from '@/lib/server-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET：任务列表 + 默认落盘目录 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json({
    tasks: listServerDownloads(),
    roots: getDownloadRoots(),
  });
}

/**
 * POST：创建下载任务。
 * body: {
 *   title, kind?: 'movie'|'tv', sourceName?, targetDir?,
 *   episodes: [{ url, episode?, title? }]
 * }
 * 不强制换源：默认用当前播放源的地址；全剧把该源全部集数一次提交即可。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: {
    title?: string;
    kind?: MediaKind;
    sourceName?: string;
    targetDir?: string;
    episodes?: Array<{ url?: string; episode?: number; title?: string }>;
    /** 兼容单集快捷字段 */
    url?: string;
    episode?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('请求格式错误', 400);
  }

  const episodes =
    body.episodes?.filter((e) => e?.url)?.map((e) => ({
      url: String(e.url),
      episode: typeof e.episode === 'number' ? e.episode : undefined,
      title: e.title ? String(e.title) : undefined,
    })) ??
    (body.url ? [{ url: String(body.url), episode: body.episode }] : []);

  try {
    const task = await createServerDownload({
      title: String(body.title || '').trim(),
      kind: body.kind,
      sourceName: body.sourceName ? String(body.sourceName) : undefined,
      targetDir: body.targetDir ? String(body.targetDir) : undefined,
      episodes,
    });
    return NextResponse.json({ task, roots: getDownloadRoots() });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '创建失败', 400);
  }
}
