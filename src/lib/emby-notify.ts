/**
 * 下载完成后通知 Emby 增量刷新媒体库。
 * 优先 POST /Library/Media/Updated（按路径）；未配置或失败时返回可展示的提示文案。
 */

export interface EmbyNotifyResult {
  ok: boolean;
  /** 给人看的短句；成功也给一句 */
  message: string;
  skipped?: boolean;
}

function embyBaseUrl(): string {
  return (process.env.EMBY_URL || '').trim().replace(/\/+$/, '');
}

function embyApiKey(): string {
  return (process.env.EMBY_API_KEY || '').trim();
}

/**
 * 路径映射：LibreTV 容器内路径 → Emby 容器内路径。
 * 格式：`/media/Movies:/mnt/movies,/media/TVShows:/mnt/tv`
 */
function parsePathMap(): Array<{ from: string; to: string }> {
  const raw = (process.env.EMBY_PATH_MAP || '').trim();
  if (!raw) {
    return [
      { from: '/media/Movies', to: '/mnt/movies' },
      { from: '/media/TVShows', to: '/mnt/tv' },
    ];
  }
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx <= 0) return null;
      const from = pair.slice(0, idx).trim().replace(/\/+$/, '');
      const to = pair.slice(idx + 1).trim().replace(/\/+$/, '');
      if (!from || !to) return null;
      return { from, to };
    })
    .filter((x): x is { from: string; to: string } => !!x)
    .sort((a, b) => b.from.length - a.from.length);
}

export function mapPathForEmby(localPath: string): string {
  const normalized = localPath.replace(/\\/g, '/');
  for (const { from, to } of parsePathMap()) {
    if (normalized === from || normalized.startsWith(from + '/')) {
      return to + normalized.slice(from.length);
    }
  }
  return normalized;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 通知 Emby：给定 LibreTV 侧已落盘路径列表（文件或目录均可）。
 * 未配置 EMBY_URL / EMBY_API_KEY 时跳过（不算失败提示）。
 */
export async function notifyEmbyMediaUpdated(
  localPaths: string[],
  opts?: { signal?: AbortSignal }
): Promise<EmbyNotifyResult> {
  const base = embyBaseUrl();
  const key = embyApiKey();
  if (!base || !key) {
    return { ok: true, skipped: true, message: '未配置 Emby，已跳过媒体库刷新' };
  }

  const mapped = uniquePaths(localPaths.map(mapPathForEmby));
  if (!mapped.length) {
    return { ok: false, message: 'Emby 刷新失败：无有效路径' };
  }

  const url = `${base}/emby/Library/Media/Updated?api_key=${encodeURIComponent(key)}`;
  const body = {
    Updates: mapped.map((Path) => ({ Path, UpdateType: 'Created' as const })),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Token': key,
      },
      body: JSON.stringify(body),
      signal: opts?.signal ?? AbortSignal.timeout(15_000),
    });
    if (res.ok || res.status === 204) {
      return {
        ok: true,
        message: `已通知 Emby 刷新（${mapped.length} 项）`,
      };
    }
    const text = (await res.text().catch(() => '')).trim().slice(0, 120);
    return {
      ok: false,
      message: `Emby 刷新失败：HTTP ${res.status}${text ? ` ${text}` : ''}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Emby 刷新失败：${msg.slice(0, 120)}` };
  }
}
