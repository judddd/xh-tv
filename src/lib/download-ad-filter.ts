/**
 * 下载前广告过滤：复用播放侧 stripAdGroups（保守启发式，不事后裁切）。
 * - 能识别：URL 特征（adjump 等）/ 两长夹一短中插 / 片头短插入段
 * - 无法识别：无标记混入正片的广告 → 标记「未检测到可识别广告」提示残留可能
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAbsolute, stripAdGroups } from './m3u8';
import { inferHeightFromBitrate, pickVariant } from './m3u8-parse';

export type AdFilterStatus = 'removed' | 'none';

export interface AdFilterReport {
  status: AdFilterStatus;
  /** 给人看的短标签 */
  label: string;
  removedSegments: number;
  removedSeconds: number;
  originalSegments: number;
  keptSegments: number;
  /** 源清单是否出现过可识别广告 URL 特征（过滤前） */
  hadMarkedAdUrls: boolean;
}

export interface PreparedPlaylist {
  /** 本地绝对路径的过滤后 m3u8，给 ffmpeg -i（远程分片绝对 URL） */
  localPath: string;
  /** 工作目录（含 index.m3u8）；cleanup 会删掉 */
  workDir: string;
  /** 绝对化后的 media playlist 文本 */
  playlistText: string;
  baseUrl: string;
  segmentCount: number;
  durationSec: number;
  adFilter: AdFilterReport;
  cleanup: () => void;
}

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const AD_URL_RE = /adjump|advert|\/ads?\//i;

function countSegments(content: string): { count: number; seconds: number } {
  let count = 0;
  let seconds = 0;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) {
      seconds += parseFloat(m[1]) || 0;
      count += 1;
    }
  }
  return { count, seconds };
}

function hasMarkedAdUrls(content: string): boolean {
  return content.split('\n').some((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#') && AD_URL_RE.test(t);
  });
}

/** 把相对 URI 绝对化，便于 ffmpeg 直接拉取（含 KEY/MAP） */
function absolutizePlaylist(content: string, baseUrl: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
        return line.replace(/(URI=")([^"]+)(")/g, (_m, p1: string, uri: string, p2: string) => {
          if (/^https?:\/\//i.test(uri)) return `${p1}${uri}${p2}`;
          return `${p1}${makeAbsolute(uri, baseUrl)}${p2}`;
        });
      }
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      if (/^https?:\/\//i.test(t)) return t;
      return makeAbsolute(t, baseUrl);
    })
    .join('\n');
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: '*/*', 'User-Agent': UA },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!res.ok) throw new Error(`播放列表拉取失败：HTTP ${res.status}`);
  return res.text();
}

/**
 * 若是 master playlist，选最高档 media 列表；返回 media 内容与其最终 URL（作绝对化基址）。
 */
async function resolveMediaPlaylist(
  entryUrl: string,
  signal: AbortSignal
): Promise<{ text: string; baseUrl: string }> {
  const text = await fetchText(entryUrl, signal);
  if (!text.includes('#EXT-X-STREAM-INF')) {
    return { text, baseUrl: entryUrl };
  }
  const variants: Array<{ url: string; height: number; bandwidth: number }> = [];
  let pending: { bandwidth: number; height?: number } | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
      const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
      pending = {
        bandwidth,
        height: resolution ? parseInt(resolution[2], 10) : undefined,
      };
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (pending) {
      variants.push({
        url: makeAbsolute(line, entryUrl),
        bandwidth: pending.bandwidth,
        height: pending.height ?? inferHeightFromBitrate(pending.bandwidth),
      });
      pending = undefined;
    }
  }
  if (!variants.length) throw new Error('master 播放列表无可用档位');
  const chosen = pickVariant(variants);
  const media = await fetchText(chosen.url, signal);
  return { text: media, baseUrl: chosen.url };
}

function buildReport(before: string, after: string): AdFilterReport {
  const b = countSegments(before);
  const a = countSegments(after);
  const removedSegments = Math.max(0, b.count - a.count);
  const removedSeconds = Math.max(0, Math.round((b.seconds - a.seconds) * 10) / 10);
  const hadMarkedAdUrls = hasMarkedAdUrls(before);

  if (removedSegments > 0) {
    const secLabel = removedSeconds >= 1 ? `约 ${Math.round(removedSeconds)} 秒` : `${removedSegments} 个分片`;
    return {
      status: 'removed',
      label: `已剔除广告（${secLabel}）`,
      removedSegments,
      removedSeconds,
      originalSegments: b.count,
      keptSegments: a.count,
      hadMarkedAdUrls,
    };
  }

  return {
    status: 'none',
    label: hadMarkedAdUrls
      ? '广告标记异常，未能剔除（可能仍有残留）'
      : '未检测到可识别广告标记（可能仍有残留）',
    removedSegments: 0,
    removedSeconds: 0,
    originalSegments: b.count,
    keptSegments: a.count,
    hadMarkedAdUrls,
  };
}

/**
 * 拉取 → 保守去广告 → 写临时 m3u8 供 ffmpeg。
 * 调用方务必在结束后 cleanup()。
 */
export async function prepareFilteredPlaylist(
  entryUrl: string,
  signal: AbortSignal
): Promise<PreparedPlaylist> {
  const { text: raw, baseUrl } = await resolveMediaPlaylist(entryUrl, signal);
  if (signal.aborted) throw new Error('已取消');

  const filtered = stripAdGroups(raw);
  const report = buildReport(raw, filtered);
  const absolute = absolutizePlaylist(filtered, baseUrl);

  if (countSegments(absolute).count === 0) {
    throw new Error('去广告后无剩余分片，已中止以免写出空文件');
  }

  const stats = countSegments(absolute);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-dl-'));
  const localPath = path.join(dir, 'index.m3u8');
  fs.writeFileSync(localPath, absolute, 'utf8');

  return {
    localPath,
    workDir: dir,
    playlistText: absolute,
    baseUrl,
    segmentCount: stats.count,
    durationSec: stats.seconds,
    adFilter: report,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
