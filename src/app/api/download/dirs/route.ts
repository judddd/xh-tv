import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { getDownloadRoots, listBrowsableDirs, resolveAllowedDir } from '@/lib/server-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET：浏览可选下载目录；?path= 缺省返回允许根与默认 Movies/TV */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const raw = sp.get('path');
  const roots = getDownloadRoots();

  if (!raw) {
    return NextResponse.json({
      roots,
      allowRoots: listBrowsableDirs(null).allowRoots,
      current: null,
      parent: null,
      dirs: listBrowsableDirs(null).dirs,
    });
  }

  try {
    const current = resolveAllowedDir(raw);
    const listed = listBrowsableDirs(current);
    return NextResponse.json({
      roots,
      allowRoots: listed.allowRoots,
      current,
      parent: listed.parent,
      dirs: listed.dirs,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '无法浏览该目录', 400);
  }
}

/** POST：创建子目录（在允许根下） */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: { parent?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('请求格式错误', 400);
  }
  const name = String(body.name || '')
    .replace(/[\/\\?%*:|"<>]/g, '')
    .trim();
  if (!name) return jsonError('文件夹名无效', 400);
  try {
    const parent = resolveAllowedDir(String(body.parent || ''));
    const target = path.join(parent, name);
    // 再校验一次落点仍在允许根内
    resolveAllowedDir(target);
    fs.mkdirSync(target, { recursive: true });
    return NextResponse.json({ path: target });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '创建失败', 400);
  }
}
