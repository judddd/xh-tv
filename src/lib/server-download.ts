/**
 * 服务端 HLS → MP4 下载队列（ffmpeg 转封装）。
 * 默认落盘：电影 → DOWNLOAD_MOVIES_DIR，剧集 → DOWNLOAD_TV_DIR。
 * 浏览器端 mux.js 下载容易因 CORS/缺片/刷新丢句柄失败，且无法写到 NAS 指定目录；
 * 服务端用 ffmpeg -c copy + 断线重连，产出可直接播放的 MP4。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isValidProxyUrl, isBlockedByDNS } from './ssrf';
import { prepareFilteredPlaylist } from './download-ad-filter';
import { notifyEmbyMediaUpdated } from './emby-notify';
import {
  downloadHlsSegments,
  formatSpeedBps,
  parseMediaPlaylist,
} from './hls-segment-downloader';
import type {
  AdFilterInfo,
  DownloadPhase,
  MediaKind,
  ServerDownloadStatus,
  ServerDownloadTask,
} from './server-download-types';

export type { MediaKind, ServerDownloadStatus, ServerDownloadTask, AdFilterInfo } from './server-download-types';
export { formatSpeedBps } from './hls-segment-downloader';

export interface ServerDownloadEpisode {
  url: string;
  /** 集数（1 基）；电影可省略 */
  episode?: number;
  /** 季数（1 基）；缺省时从剧名「第N季」解析，再不行默认 1 */
  season?: number;
  title?: string;
}

interface CreateInput {
  title: string;
  kind?: MediaKind;
  sourceName?: string;
  /** 自定义目录（必须在允许根目录下） */
  targetDir?: string;
  episodes: ServerDownloadEpisode[];
}

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const MOVIES_DIR = process.env.DOWNLOAD_MOVIES_DIR || '/media/Movies';
const TV_DIR = process.env.DOWNLOAD_TV_DIR || '/media/TVShows';
const STATE_FILE = process.env.DOWNLOAD_STATE_FILE || '/data/state/downloads.json';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.DOWNLOAD_CONCURRENCY || '2', 10) || 2);
/** 同一剧集任务内并行拉几集；有分片并行后默认 4，避免互抢带宽 */
const EPISODE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.DOWNLOAD_EPISODE_CONCURRENCY || '4', 10) || 4
);
const FFMPEG_RETRIES = Math.max(1, parseInt(process.env.DOWNLOAD_RETRIES || '3', 10) || 3);
/** segments=并行拉片+本地封装（默认）；ffmpeg=旧链路直拉 */
const DOWNLOAD_ENGINE = (process.env.DOWNLOAD_ENGINE || 'segments').toLowerCase();
const KEEP_SEGS = process.env.DOWNLOAD_KEEP_SEGS === '1';
/** 单集整段（拉片+封装）失败后重试次数 */
const EPISODE_FILE_RETRIES = Math.max(1, parseInt(process.env.DOWNLOAD_EPISODE_RETRIES || '3', 10) || 3);
/** 全剧结束后对失败集再补几轮 */
const EPISODE_GAP_RETRY_ROUNDS = Math.max(
  0,
  parseInt(process.env.DOWNLOAD_GAP_RETRY_ROUNDS || '2', 10) || 2
);

/** 可选下载根：默认含 Movies/TV 及其父目录，可用 DOWNLOAD_ALLOW_ROOTS 追加（逗号分隔） */
function parseAllowRoots(): string[] {
  const extras = (process.env.DOWNLOAD_ALLOW_ROOTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const base = [MOVIES_DIR, TV_DIR, path.dirname(MOVIES_DIR), path.dirname(TV_DIR), '/media', '/data'];
  return [...new Set([...base, ...extras].map((p) => path.resolve(p)))];
}

const tasks = new Map<string, ServerDownloadTask>();
const abortControllers = new Map<string, AbortController>();
/** 当前正在跑的 ffmpeg（同任务可多路），用于暂停（SIGSTOP）/继续（SIGCONT） */
const runningProcs = new Map<string, Set<ChildProcess>>();
/** 分片阶段暂停门闩：resume 时唤醒 */
const pauseWaiters = new Map<string, Set<() => void>>();
let activeCount = 0;

function wakePauseWaiters(taskId: string): void {
  const set = pauseWaiters.get(taskId);
  if (!set?.size) return;
  for (const wake of set) wake();
  set.clear();
}

async function waitIfTaskPaused(taskId: string, signal: AbortSignal): Promise<void> {
  while (true) {
    if (signal.aborted) throw new Error('已取消');
    const task = tasks.get(taskId);
    if (!task || task.status !== 'paused') return;
    await new Promise<void>((resolve, reject) => {
      let set = pauseWaiters.get(taskId);
      if (!set) {
        set = new Set();
        pauseWaiters.set(taskId, set);
      }
      const wake = () => {
        set!.delete(wake);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        set!.delete(wake);
        reject(new Error('已取消'));
      };
      set.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
      // 若登记时已恢复，立刻醒
      if (tasks.get(taskId)?.status !== 'paused') wake();
    });
  }
}

function trackProc(taskId: string, child: ChildProcess): void {
  let set = runningProcs.get(taskId);
  if (!set) {
    set = new Set();
    runningProcs.set(taskId, set);
  }
  set.add(child);
}

function untrackProc(taskId: string, child: ChildProcess): void {
  const set = runningProcs.get(taskId);
  if (!set) return;
  set.delete(child);
  if (set.size === 0) runningProcs.delete(taskId);
}

function signalTaskProcs(taskId: string, sig: NodeJS.Signals): number {
  const set = runningProcs.get(taskId);
  if (!set?.size) return 0;
  let n = 0;
  for (const proc of set) {
    if (!proc.pid) continue;
    try {
      process.kill(proc.pid, sig);
      n += 1;
    } catch {
      /* ignore dead pid */
    }
  }
  return n;
}
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ServerDownloadTask[];
    for (const t of raw) {
      // 重启后进行中的任务回到排队，便于续跑
      if (t.status === 'downloading' || t.status === 'waiting' || t.status === 'paused') {
        t.status = 'waiting';
        t.progress = Math.min(t.progress, 99);
        t.message = '服务重启，等待继续';
        for (const ep of t.episodes) {
          if (ep.status === 'downloading' || ep.status === 'paused') {
            ep.status = 'waiting';
            ep.message = '等待继续';
          }
        }
      }
      tasks.set(t.id, t);
    }
  } catch {
    /* 状态文件损坏时忽略，从空队列开始 */
  }
  schedulePump();
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const dir = path.dirname(STATE_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
      fs.writeFileSync(STATE_FILE, JSON.stringify(list, null, 2));
    } catch {
      /* 落盘失败不阻断下载 */
    }
  }, 500);
}

function touch(task: ServerDownloadTask, patch: Partial<ServerDownloadTask> = {}): void {
  Object.assign(task, patch, { updatedAt: Date.now() });
  schedulePersist();
}

/** 文件名安全化：去掉路径分隔与控制字符 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

export function getDownloadRoots(): { movies: string; tv: string } {
  return { movies: path.resolve(MOVIES_DIR), tv: path.resolve(TV_DIR) };
}

export function getAllowRoots(): string[] {
  return parseAllowRoots();
}

/** 校验并解析用户选择的目录：必须落在允许根下，且目录可写（不存在则创建） */
export function resolveAllowedDir(targetDir: string): string {
  const resolved = path.resolve(targetDir);
  const roots = parseAllowRoots();
  const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) throw new Error('目标目录不在允许的下载根目录内');
  // 禁止路径穿越到敏感位置（已由 allowRoots 约束）
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function listBrowsableDirs(current: string | null): {
  allowRoots: string[];
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
} {
  const allowRoots = parseAllowRoots().filter((r) => {
    try {
      return fs.existsSync(r) && fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });

  if (!current) {
    // 顶层：展示允许根（去重后的存在目录）
    const uniq = [...new Map(allowRoots.map((p) => [p, p])).values()];
    return {
      allowRoots: uniq,
      parent: null,
      dirs: uniq.map((p) => ({ name: path.basename(p) || p, path: p })),
    };
  }

  const resolved = resolveAllowedDir(current);
  const parentDir = path.dirname(resolved);
  const parentAllowed = allowRoots.some(
    (root) => parentDir === root || parentDir.startsWith(root + path.sep) || parentDir === path.dirname(root)
  );
  // parent 必须仍在允许范围内；若当前就是某个 allowRoot，则 parent 返回 null（回到根列表）
  const isAllowRoot = allowRoots.includes(resolved);
  let parent: string | null = null;
  if (!isAllowRoot && parentAllowed) parent = parentDir;

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return { allowRoots, parent, dirs };
}

function resolveKind(kind: MediaKind | undefined, episodeCount: number): MediaKind {
  if (kind === 'movie' || kind === 'tv') return kind;
  return episodeCount > 1 ? 'tv' : 'movie';
}

function resolveBaseDir(kind: MediaKind, targetDir?: string): string {
  if (targetDir) return resolveAllowedDir(targetDir);
  return kind === 'tv' ? path.resolve(TV_DIR) : path.resolve(MOVIES_DIR);
}

/** 中文数字季 → 阿拉伯数字（支持 1–99 常用写法） */
function chineseSeasonToNumber(raw: string): number | null {
  const digits = '零一二三四五六七八九';
  const value = raw.replace(/两/g, '二').trim();
  if (/^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    return n > 0 ? n : null;
  }
  if (/^[一二三四五六七八九]$/u.test(value)) return digits.indexOf(value);
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(value)) {
    const [tens, units] = value.split('十');
    return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
  }
  return null;
}

/** 从剧名解析「第N季 / Season N / S02」；返回去掉季后缀的剧名 */
export function parseShowSeason(title: string): { base: string; season?: number } {
  const t = title.trim();
  const patterns: RegExp[] = [
    /^(.*?)\s*第\s*([0-9]+|[一二两三四五六七八九十]{1,3})\s*季\s*$/u,
    /^(.*?)\s*第\s*([0-9]+|[一二两三四五六七八九十]{1,3})\s*季\b/u,
    /^(.*?)\s*[\(\[（【]?\s*Season\s*0*([1-9]\d*)\s*[\)\]）】]?\s*$/i,
    /^(.*?)\s+S0*([1-9]\d*)\s*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m?.[1]?.trim()) continue;
    const season = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : chineseSeasonToNumber(m[2]);
    if (season && season > 0) return { base: m[1].trim(), season };
  }
  return { base: t };
}

/** 从集标题解析 S01E02 / 1x02 */
function parseEpisodeCode(text: string | undefined): { season: number; episode: number } | null {
  if (!text) return null;
  const m =
    text.match(/\bS(\d{1,2})\s*[EExx](\d{1,3})\b/i) ||
    text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (!m) return null;
  const season = parseInt(m[1], 10);
  const episode = parseInt(m[2], 10);
  if (season > 0 && episode > 0) return { season, episode };
  return null;
}

function formatSxxExx(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** 把用户选中的目录归一到「剧名」目录，避免 Season/剧名 套娃 */
function resolveTvShowDir(baseDir: string, show: string): string {
  let cur = path.resolve(baseDir);
  // 剥掉误选的 Season N / Specials
  while (/^Season\s+\d+$/i.test(path.basename(cur)) || /^Specials$/i.test(path.basename(cur))) {
    cur = path.dirname(cur);
  }
  if (path.basename(cur) === show) return cur;
  return path.join(cur, show);
}

/**
 * Emby 友好路径：
 * - 电影：`{base}/{剧名}.mp4`
 * - 剧集：`{base}/{剧名}/Season {N}/{剧名} SxxExx.mp4`
 * 若用户已选中剧名目录（basename==剧名），不再套一层。
 */
function buildOutputPath(
  kind: MediaKind,
  title: string,
  episode: number | undefined,
  episodeTitle: string | undefined,
  baseDir: string,
  seasonHint?: number
): string {
  if (kind === 'movie') {
    const safe = sanitizeFilename(title);
    return path.join(baseDir, `${safe}.mp4`);
  }

  const parsed = parseShowSeason(title);
  const fromCode = parseEpisodeCode(episodeTitle);
  const show = sanitizeFilename(parsed.base || title);
  const season =
    (seasonHint && seasonHint > 0 ? seasonHint : undefined) ||
    fromCode?.season ||
    parsed.season ||
    1;
  const epNum = fromCode?.episode || (episode && episode > 0 ? episode : 1);
  const code = formatSxxExx(season, epNum);

  const showDir = resolveTvShowDir(baseDir, show);
  const seasonDir = path.join(showDir, `Season ${season}`);
  return path.join(seasonDir, `${show} ${code}.mp4`);
}

const MIN_OUTPUT_BYTES = 1024 * 100;
/** 成片相对源清单时长至少要达到该比例，否则视为未下全 */
const MIN_DURATION_RATIO = Math.min(
  0.99,
  Math.max(0.5, parseFloat(process.env.DOWNLOAD_MIN_DURATION_RATIO || '0.92') || 0.92)
);

function assertOutputFile(outputPath: string): void {
  if (!fs.existsSync(outputPath)) throw new Error('落盘文件不存在');
  const size = fs.statSync(outputPath).size;
  if (size < MIN_OUTPUT_BYTES) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
    throw new Error(`落盘文件过小（${size} 字节），已删除待重试`);
  }
}

interface MediaProbe {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  size: number;
}

/** ffprobe 校验：有时长、有视频轨；相对期望时长不能明显偏短 */
function probeOutputMedia(filePath: string, signal: AbortSignal): Promise<MediaProbe | null> {
  return new Promise((resolve) => {
    const PROBE_TIMEOUT_MS = 20_000;
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      filePath,
    ];
    let settled = false;
    const finish = (value: MediaProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(null);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(null);
    }, PROBE_TIMEOUT_MS);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (buf: Buffer) => {
      out += buf.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        const json = JSON.parse(out) as {
          format?: { duration?: string };
          streams?: Array<{ codec_type?: string }>;
        };
        const durationSec = parseFloat(json.format?.duration || '');
        const streams = json.streams || [];
        const hasVideo = streams.some((s) => s.codec_type === 'video');
        const hasAudio = streams.some((s) => s.codec_type === 'audio');
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
          finish(null);
          return;
        }
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          /* ignore */
        }
        finish({ durationSec, hasVideo, hasAudio, size });
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * 下载完成后的硬校验：文件大小 + ffprobe 可播 + 时长不低于源清单期望。
 * 失败会删除残片，迫使重下。
 */
async function verifyOutputMedia(
  outputPath: string,
  signal: AbortSignal,
  expectedDurationSec?: number | null
): Promise<MediaProbe> {
  assertOutputFile(outputPath);
  const probe = await probeOutputMedia(outputPath, signal);
  if (!probe) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
    throw new Error('成片校验失败：ffprobe 无法读取时长/流信息，已删除残片');
  }
  if (!probe.hasVideo) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
    throw new Error('成片校验失败：无视频轨，已删除残片');
  }
  if (expectedDurationSec && expectedDurationSec >= 60) {
    const minOk = expectedDurationSec * MIN_DURATION_RATIO;
    if (probe.durationSec + 1 < minOk) {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* ignore */
      }
      throw new Error(
        `成片未下全：时长 ${probe.durationSec.toFixed(0)}s / 期望约 ${expectedDurationSec.toFixed(0)}s（<${Math.round(MIN_DURATION_RATIO * 100)}%），已删除残片`
      );
    }
  }
  return probe;
}

async function assertUrlAllowed(url: string): Promise<void> {
  if (!isValidProxyUrl(url)) throw new Error('无效的播放地址');
  if (await isBlockedByDNS(url)) throw new Error('不允许访问私有/保留网络地址');
}

function parseFfmpegProgress(line: string, durationSec: number | null): number | null {
  // frame=... time=00:01:23.45 ...
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m || !durationSec || durationSec <= 0) return null;
  const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  return Math.max(0, Math.min(99, Math.round((sec / durationSec) * 100)));
}

function probeDurationSec(url: string, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    // 进度条可选：探时长最多 12s，超时直接开下，避免卡死在 ffprobe
    const PROBE_TIMEOUT_MS = 12_000;
    const isLocal = url.endsWith('.m3u8') && !/^https?:\/\//i.test(url);
    const args = [
      '-v', 'error',
      ...(isLocal
        ? ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data']
        : ['-user_agent', UA]),
      '-probesize', '32k',
      '-analyzeduration', '2000000',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      url,
    ];
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, PROBE_TIMEOUT_MS);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (buf: Buffer) => {
      out += buf.toString();
    });
    child.on('close', () => {
      const n = parseFloat(out.trim());
      finish(Number.isFinite(n) && n > 0 ? n : null);
    });
    child.on('error', () => finish(null));
  });
}

function runFfmpegOnce(
  taskId: string,
  input: string,
  outPart: string,
  signal: AbortSignal,
  onProgress: (pct: number) => void,
  durationSec: number | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPart), { recursive: true });
    // 本地过滤后的 m3u8：file 输入不能带 http 专用选项（-headers/-user_agent/-reconnect/-timeout
    // 会报 Option not found）。子分片走 https 时靠 protocol_whitelist + 默认 UA 即可。
    const isLocalList = input.endsWith('.m3u8') && !/^https?:\/\//i.test(input);
    const args = [
      '-y',
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-stats',
      ...(isLocalList
        ? [
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
            '-http_persistent', '1',
            '-http_multiple', '1',
          ]
        : [
            '-user_agent', UA,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '30',
            '-timeout', '30000000',
            '-http_persistent', '1',
            '-http_multiple', '1',
          ]),
      '-i', input,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outPart,
    ];
    let child: ChildProcess;
    try {
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    trackProc(taskId, child);

    let errBuf = '';
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch { /* ignore */ }
    };
    if (signal.aborted) {
      onAbort();
      untrackProc(taskId, child);
      reject(new Error('已取消'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      errBuf = (errBuf + text).slice(-4000);
      const pct = parseFfmpegProgress(text, durationSec);
      if (pct != null) onProgress(pct);
    });

    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      untrackProc(taskId, child);
      reject(new Error(`无法启动 ffmpeg：${err.message}`));
    });

    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      untrackProc(taskId, child);
      if (signal.aborted) {
        reject(new Error('已取消'));
        return;
      }
      if (code === 0 && fs.existsSync(outPart) && fs.statSync(outPart).size > 0) {
        resolve();
        return;
      }
      const hint = errBuf.trim().split('\n').filter(Boolean).slice(-3).join('；') || `exit ${code}`;
      reject(new Error(`ffmpeg 失败：${hint}`));
    });
  });
}

type ProgressMeta = {
  speedBps?: number;
  phase?: DownloadPhase;
  detail?: string;
};

interface EpisodeDownloadResult {
  adFilter: AdFilterInfo;
  verifiedDurationSec?: number;
}

async function downloadEpisodeFile(
  taskId: string,
  url: string,
  outputPath: string,
  signal: AbortSignal,
  onProgress: (pct: number, meta?: ProgressMeta) => void,
  onAdFilter?: (info: AdFilterInfo) => void
): Promise<EpisodeDownloadResult> {
  await assertUrlAllowed(url);
  // 必须保留 .mp4 后缀：ffmpeg 靠扩展名选 muxer，`.mp4.part` 会被当成未知格式
  const part = `${outputPath}.part.mp4`;
  const segsDir = `${outputPath}.segs`;
  // 清理残留临时 mp4（分片目录保留以支持续传）
  try {
    if (fs.existsSync(part)) fs.unlinkSync(part);
  } catch { /* ignore */ }

  // 已存在文件：仍做可播校验，坏片删掉重下
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= MIN_OUTPUT_BYTES) {
    onProgress(99, { phase: 'verify', detail: '校验已有成片', speedBps: 0 });
    try {
      const probe = await verifyOutputMedia(outputPath, signal, null);
      const skipped: AdFilterInfo = { status: 'none', label: '已存在文件，校验通过（未重跑去广告）' };
      onAdFilter?.(skipped);
      onProgress(100, { phase: 'done', speedBps: 0 });
      return { adFilter: skipped, verifiedDurationSec: probe.durationSec };
    } catch {
      // 残片已在 verify 里删除，继续正常下载
      onProgress(0, { phase: 'filter', detail: '已有成片校验失败，重新下载', speedBps: 0 });
    }
  }

  let lastErr: unknown;
  for (let fileAttempt = 1; fileAttempt <= EPISODE_FILE_RETRIES; fileAttempt++) {
    if (signal.aborted) throw new Error('已取消');
    await waitIfTaskPaused(taskId, signal);

    onProgress(0, {
      phase: 'filter',
      detail: fileAttempt > 1 ? `去广告处理中（重试 ${fileAttempt}/${EPISODE_FILE_RETRIES}）` : '去广告处理中',
      speedBps: 0,
    });
    const prepared = await prepareFilteredPlaylist(url, signal);
    const adFilter: AdFilterInfo = {
      status: prepared.adFilter.status,
      label: prepared.adFilter.label,
      removedSegments: prepared.adFilter.removedSegments,
      removedSeconds: prepared.adFilter.removedSeconds,
    };
    onAdFilter?.(adFilter);

    const parsed = parseMediaPlaylist(prepared.playlistText);
    const useSegments =
      DOWNLOAD_ENGINE !== 'ffmpeg' && parsed.supportsParallel && parsed.segments.length > 0;
    const durationSec = prepared.durationSec > 0 ? prepared.durationSec : parsed.totalDuration || null;

    const runMux = async (input: string, mapProgress: (p: number) => number) => {
      let muxErr: unknown;
      for (let attempt = 1; attempt <= FFMPEG_RETRIES; attempt++) {
        if (signal.aborted) throw new Error('已取消');
        await waitIfTaskPaused(taskId, signal);
        try {
          await runFfmpegOnce(
            taskId,
            input,
            part,
            signal,
            (pct) => onProgress(mapProgress(pct), { phase: 'mux', detail: '封装 MP4' }),
            durationSec
          );
          fs.renameSync(part, outputPath);
          return;
        } catch (err) {
          muxErr = err;
          try {
            if (fs.existsSync(part)) fs.unlinkSync(part);
          } catch { /* ignore */ }
          if (signal.aborted) throw new Error('已取消');
          if (attempt < FFMPEG_RETRIES) await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      throw muxErr instanceof Error ? muxErr : new Error(String(muxErr));
    };

    try {
      if (useSegments) {
        fs.mkdirSync(segsDir, { recursive: true });
        try {
          fs.writeFileSync(path.join(segsDir, 'source.m3u8'), prepared.playlistText, 'utf8');
        } catch { /* ignore */ }

        await downloadHlsSegments(prepared.playlistText, {
          workDir: segsDir,
          signal,
          resume: true,
          waitIfPaused: () => waitIfTaskPaused(taskId, signal),
          onProgress: (p) => {
            const pct = Math.min(88, Math.round((p.done / Math.max(1, p.total)) * 88));
            onProgress(pct, {
              phase: 'segments',
              speedBps: p.speedBps,
              detail: `拉片 ${p.done}/${p.total} · ${formatSpeedBps(p.speedBps)}`,
            });
          },
        });

        const localList = path.join(segsDir, 'index.local.m3u8');
        onProgress(88, { phase: 'mux', speedBps: 0, detail: '封装 MP4' });
        await runMux(localList, (pct) => 88 + Math.round((pct / 100) * 7));

        if (!KEEP_SEGS) {
          try {
            fs.rmSync(segsDir, { recursive: true, force: true });
          } catch { /* ignore */ }
        }
        onProgress(96, { phase: 'verify', speedBps: 0, detail: '校验成片完整性' });
        const probe = await verifyOutputMedia(outputPath, signal, durationSec);
        onProgress(100, { phase: 'done', speedBps: 0, detail: `校验通过 · ${Math.round(probe.durationSec)}s` });
        return { adFilter, verifiedDurationSec: probe.durationSec };
      }

      onProgress(1, {
        phase: 'mux',
        detail: parsed.unsupportedReason
          ? `回退 ffmpeg（${parsed.unsupportedReason}）`
          : 'ffmpeg 直拉',
        speedBps: 0,
      });
      await runMux(prepared.localPath, (pct) => Math.min(95, pct));
      onProgress(96, { phase: 'verify', speedBps: 0, detail: '校验成片完整性' });
      const probe = await verifyOutputMedia(outputPath, signal, durationSec);
      onProgress(100, { phase: 'done', speedBps: 0, detail: `校验通过 · ${Math.round(probe.durationSec)}s` });
      return { adFilter, verifiedDurationSec: probe.durationSec };
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw new Error('已取消');
      if (fileAttempt < EPISODE_FILE_RETRIES) {
        onProgress(0, {
          phase: 'filter',
          detail: `本集失败，准备重试（${fileAttempt}/${EPISODE_FILE_RETRIES}）：${err instanceof Error ? err.message : String(err)}`.slice(0, 120),
          speedBps: 0,
        });
        await new Promise((r) => setTimeout(r, 1500 * fileAttempt));
      }
    } finally {
      prepared.cleanup();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function refreshTaskProgress(task: ServerDownloadTask): void {
  const total = task.episodes.length || 1;
  const sumPct = task.episodes.reduce((s, e) => s + Math.min(100, Math.max(0, e.progress || 0)), 0);
  const done = task.episodes.filter((e) => e.status === 'completed').length;
  const activeEps = task.episodes.filter((e) => e.status === 'downloading');
  const speedBps = activeEps.reduce((s, e) => s + (e.speedBps || 0), 0);
  const phase = activeEps.find((e) => e.phase)?.phase;
  const overall = Math.min(99, Math.round(sumPct / total));
  const speedLabel = speedBps > 0 ? ` · ${formatSpeedBps(speedBps)}` : '';
  touch(task, {
    status: task.status === 'paused' ? 'paused' : 'downloading',
    progress: overall,
    speedBps: speedBps > 0 ? speedBps : undefined,
    phase,
    message:
      activeEps.length > 0
        ? `并行 ${activeEps.length} 路 · 已完成 ${done}/${total}${speedLabel}`
        : `已完成 ${done}/${total}`,
  });
}

function episodeLabel(ep: ServerDownloadTask['episodes'][number], index: number): string {
  if (ep.episode && ep.episode > 0) return `E${String(ep.episode).padStart(2, '0')}`;
  return `#${index + 1}`;
}

/** 有限并发跑集数；单集失败不拖垮全剧，结束后自动补下失败集 */
async function runEpisodesPool(
  task: ServerDownloadTask,
  signal: AbortSignal,
  indices: number[]
): Promise<void> {
  const total = task.episodes.length;
  let cancelledErr: unknown;

  const runBatch = async (batch: number[]) => {
    if (!batch.length) return;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (signal.aborted) throw new Error('已取消');
        const my = cursor++;
        if (my >= batch.length) return;
        const i = batch[my];
        const ep = task.episodes[i];

        ep.status = 'downloading';
        ep.progress = 0;
        ep.message = '下载中';
        refreshTaskProgress(task);

        try {
          const result = await downloadEpisodeFile(
            task.id,
            ep.url,
            ep.outputPath!,
            signal,
            (pct, meta) => {
              if (task.status === 'paused') return;
              ep.progress = pct;
              if (meta?.speedBps != null) ep.speedBps = meta.speedBps;
              if (meta?.phase) ep.phase = meta.phase;
              if (meta?.detail) ep.message = meta.detail;
              refreshTaskProgress(task);
            },
            (info) => {
              ep.adFilter = info;
              ep.message = info.label;
              refreshTaskProgress(task);
            }
          );
          ep.adFilter = result.adFilter;
          ep.verifiedDurationSec = result.verifiedDurationSec;
          ep.status = 'completed';
          ep.progress = 100;
          ep.speedBps = 0;
          ep.phase = 'done';
          ep.message = result.verifiedDurationSec
            ? `${result.adFilter.label} · 校验通过 ${Math.round(result.verifiedDurationSec)}s`
            : result.adFilter.label;
          refreshTaskProgress(task);
        } catch (err) {
          ep.status = signal.aborted ? 'cancelled' : 'error';
          ep.progress = Math.min(ep.progress || 0, 99);
          ep.speedBps = 0;
          ep.message = err instanceof Error ? err.message : String(err);
          touch(task);
          if (signal.aborted) {
            cancelledErr = err;
            throw err;
          }
          if (total === 1) throw err;
        }
      }
    };

    const n = Math.min(EPISODE_CONCURRENCY, batch.length);
    const results = await Promise.allSettled(Array.from({ length: n }, () => worker()));
    if (signal.aborted || cancelledErr) {
      throw cancelledErr instanceof Error ? cancelledErr : new Error('已取消');
    }
    const hard = results.find(
      (r) => r.status === 'rejected' && !(r.reason instanceof Error && r.reason.message === '已取消')
    );
    if (total === 1 && hard && hard.status === 'rejected') throw hard.reason;
  };

  await runBatch(indices);

  // 全剧缺口补下：失败 / 声称完成但文件不在
  for (let round = 1; round <= EPISODE_GAP_RETRY_ROUNDS; round++) {
    if (signal.aborted) throw new Error('已取消');
    const gaps: number[] = [];
    for (const i of indices) {
      const ep = task.episodes[i];
      if (ep.status === 'error' || ep.status === 'cancelled') {
        gaps.push(i);
        continue;
      }
      if (ep.status === 'completed') {
        try {
          const probe = await verifyOutputMedia(ep.outputPath!, signal, null);
          ep.verifiedDurationSec = probe.durationSec;
        } catch {
          ep.status = 'error';
          ep.message = '完成后文件校验失败，准备补下';
          gaps.push(i);
        }
      }
    }
    if (!gaps.length) break;
    const labels = gaps.map((i) => episodeLabel(task.episodes[i], i)).join('、');
    touch(task, {
      status: 'downloading',
      message: `补下缺集 ${gaps.length} 集（第 ${round}/${EPISODE_GAP_RETRY_ROUNDS} 轮）：${labels}`.slice(0, 160),
    });
    for (const i of gaps) {
      const ep = task.episodes[i];
      ep.status = 'waiting';
      ep.progress = 0;
      ep.message = `补下排队（第 ${round} 轮）`;
    }
    await runBatch(gaps);
  }
}

async function runTask(task: ServerDownloadTask): Promise<void> {
  const ac = abortControllers.get(task.id);
  if (!ac) return;
  const signal = ac.signal;
  touch(task, { status: 'downloading', message: '下载中', progress: 0 });

  const total = task.episodes.length;

  try {
    const pending: number[] = [];
    for (let i = 0; i < task.episodes.length; i++) {
      const ep = task.episodes[i];
      if (ep.status === 'completed' && ep.outputPath) {
        try {
          const probe = await verifyOutputMedia(ep.outputPath, signal, null);
          ep.verifiedDurationSec = probe.durationSec;
          ep.progress = 100;
          continue;
        } catch {
          ep.status = 'waiting';
          ep.message = '文件校验失败，重新下载';
        }
      }
      pending.push(i);
    }
    refreshTaskProgress(task);

    if (pending.length) {
      await runEpisodesPool(task, signal, pending);
    }

    // 最终再扫一遍：完成态必须通过可播校验
    touch(task, { message: '最终校验全部成片…', phase: 'verify', speedBps: 0 });
    for (const ep of task.episodes) {
      if (ep.status !== 'completed' || !ep.outputPath) continue;
      try {
        const probe = await verifyOutputMedia(ep.outputPath, signal, null);
        ep.verifiedDurationSec = probe.durationSec;
        if (!ep.message?.includes('校验通过')) {
          ep.message = `${ep.message || '完成'} · 校验通过 ${Math.round(probe.durationSec)}s`;
        }
      } catch (err) {
        ep.status = 'error';
        ep.message = err instanceof Error ? err.message : String(err);
      }
    }

    const failedEps = task.episodes.filter((e) => e.status === 'error' || e.status === 'cancelled');
    const failed = failedEps.length;
    const completed = task.episodes.filter((e) => e.status === 'completed').length;
    if (completed === 0) {
      touch(task, {
        status: 'error',
        message: failed ? `全部失败（${failed} 集）` : '无成功文件',
        progress: 0,
        speedBps: 0,
      });
      return;
    }
    if (failed > 0) {
      const labels = failedEps
        .map((e, idx) => episodeLabel(e, task.episodes.indexOf(e) >= 0 ? task.episodes.indexOf(e) : idx))
        .slice(0, 12)
        .join('、');
      touch(task, {
        status: 'error',
        progress: Math.round((completed / total) * 100),
        speedBps: 0,
        message: `仍缺 ${failed}/${total} 集未完成：${labels}${failed > 12 ? '…' : ''}（可点重试）`.slice(0, 200),
      });
      return;
    }
    const removedEps = task.episodes.filter((e) => e.adFilter?.status === 'removed');
    const removedSec = removedEps.reduce((s, e) => s + (e.adFilter?.removedSeconds || 0), 0);
    const adFilter: AdFilterInfo =
      removedEps.length > 0
        ? {
            status: 'removed',
            label: `已剔除广告（${removedEps.length}/${completed} 集，约 ${Math.round(removedSec)} 秒）`,
            removedSeconds: removedSec,
            removedSegments: removedEps.reduce((s, e) => s + (e.adFilter?.removedSegments || 0), 0),
          }
        : {
            status: 'none',
            label: '未检测到可识别广告标记（可能仍有残留）',
          };
    // 剧集：任务路径指到剧名目录（…/Show），不是 Season 子目录
    const firstOut = task.episodes.find((e) => e.outputPath)?.outputPath || '';
    const outputPath =
      task.kind === 'movie'
        ? task.episodes[0]?.outputPath
        : firstOut
          ? path.dirname(path.dirname(firstOut))
          : undefined;
    const baseMsg = `全部完成并校验通过（${completed} 集）· ${adFilter.label}`;
    touch(task, {
      status: 'completed',
      progress: 100,
      speedBps: 0,
      phase: 'done',
      adFilter,
      message: baseMsg,
      outputPath,
    });

    // 下载成功后增量通知 Emby；失败只写提示，不改 completed
    const paths = task.episodes
      .filter((e) => e.status === 'completed' && e.outputPath)
      .map((e) => e.outputPath!);
    if (task.kind === 'tv' && outputPath) paths.unshift(outputPath);
    try {
      const emby = await notifyEmbyMediaUpdated(paths);
      if (!emby.skipped) {
        touch(task, {
          embyNotify: emby,
          message: `${baseMsg} · ${emby.message}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      touch(task, {
        embyNotify: { ok: false, message: `Emby 刷新失败：${msg.slice(0, 120)}` },
        message: `${baseMsg} · Emby 刷新失败`,
      });
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === '已取消')) {
      touch(task, { status: 'cancelled', message: '已取消' });
    } else {
      touch(task, {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function schedulePump(): void {
  ensureLoaded();
  while (activeCount < MAX_CONCURRENT) {
    const next = [...tasks.values()].find((t) => t.status === 'waiting');
    if (!next) return;
    activeCount += 1;
    if (!abortControllers.has(next.id)) {
      abortControllers.set(next.id, new AbortController());
    }
    void runTask(next).finally(() => {
      activeCount -= 1;
      // 取消后清掉 controller；暂停中的任务仍占用逻辑由 status 控制
      if (tasks.get(next.id)?.status !== 'paused') {
        abortControllers.delete(next.id);
      }
      schedulePump();
    });
  }
}

/** 暂停：SIGSTOP 挂起 ffmpeg；分片阶段靠 waitIfPaused 门闩停发请求 */
export function pauseServerDownload(id: string): boolean {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task || task.status !== 'downloading') return false;
  signalTaskProcs(id, 'SIGSTOP');
  touch(task, { status: 'paused', message: '已暂停', speedBps: 0 });
  for (const ep of task.episodes) {
    if (ep.status === 'downloading') {
      ep.message = '已暂停';
      ep.speedBps = 0;
    }
  }
  return true;
}

/** 继续：SIGCONT 恢复 ffmpeg，并唤醒分片下载门闩 */
export function resumeServerDownload(id: string): boolean {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task || task.status !== 'paused') return false;
  signalTaskProcs(id, 'SIGCONT');

  // runTask 仍在（有 AbortController）→ 只恢复状态并唤醒拉片工人
  if (abortControllers.has(id)) {
    touch(task, { status: 'downloading', message: '继续下载' });
    for (const ep of task.episodes) {
      if (ep.status === 'downloading') ep.message = '下载中';
    }
    wakePauseWaiters(id);
    return true;
  }

  // runTask 已结束：重新排队（分片目录可续传）
  touch(task, { status: 'waiting', message: '重新排队' });
  for (const ep of task.episodes) {
    if (ep.status === 'downloading' || ep.status === 'paused') {
      ep.status = 'waiting';
      ep.message = '等待继续';
    }
  }
  abortControllers.set(id, new AbortController());
  schedulePump();
  return true;
}

export function listServerDownloads(): ServerDownloadTask[] {
  ensureLoaded();
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getServerDownload(id: string): ServerDownloadTask | undefined {
  ensureLoaded();
  return tasks.get(id);
}

export async function createServerDownload(input: CreateInput): Promise<ServerDownloadTask> {
  ensureLoaded();
  if (!input.title?.trim()) throw new Error('缺少标题');
  if (!input.episodes?.length) throw new Error('缺少下载条目');
  if (input.episodes.length > 200) throw new Error('单次最多 200 集');

  const kind = resolveKind(input.kind, input.episodes.length);
  const baseDir = resolveBaseDir(kind, input.targetDir);

  // 预先校验 URL；过滤空地址，避免「全集缺几集」里混进无效条目
  const cleaned = input.episodes.filter((ep) => Boolean(ep?.url?.trim()));
  if (!cleaned.length) throw new Error('缺少有效播放地址');
  if (cleaned.length !== input.episodes.length) {
    // 保留有效集，后续仍按原 episode 编号落盘
  }
  for (const ep of cleaned) {
    await assertUrlAllowed(ep.url);
  }
  input = { ...input, episodes: cleaned };

  const id = `sdl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const task: ServerDownloadTask = {
    id,
    title: input.title.trim(),
    kind,
    status: 'waiting',
    progress: 0,
    message: '排队中',
    sourceName: input.sourceName,
    episodes: input.episodes.map((ep, idx) => {
      const episode = ep.episode ?? (kind === 'tv' ? idx + 1 : undefined);
      const season = ep.season && ep.season > 0 ? ep.season : undefined;
      const outputPath = buildOutputPath(
        kind,
        input.title.trim(),
        episode,
        ep.title,
        baseDir,
        season
      );
      return {
        url: ep.url,
        episode,
        season,
        title: ep.title,
        status: 'waiting' as ServerDownloadStatus,
        progress: 0,
        outputPath,
      };
    }),
    createdAt: now,
    updatedAt: now,
  };

  // 电影单文件路径挂到任务级
  if (kind === 'movie') task.outputPath = task.episodes[0]?.outputPath;

  tasks.set(id, task);
  schedulePersist();
  schedulePump();
  return task;
}

export function cancelServerDownload(id: string): boolean {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task) return false;
  abortControllers.get(id)?.abort();
  if (task.status === 'waiting' || task.status === 'downloading' || task.status === 'paused') {
    touch(task, { status: 'cancelled', message: '已取消' });
    for (const ep of task.episodes) {
      if (ep.status === 'waiting' || ep.status === 'downloading' || ep.status === 'paused') {
        ep.status = 'cancelled';
        ep.message = '已取消';
        // 清掉未完成临时文件，避免磁盘残留
        if (ep.outputPath) {
          const part = `${ep.outputPath}.part.mp4`;
          try {
            if (fs.existsSync(part)) fs.unlinkSync(part);
          } catch { /* ignore */ }
        }
      }
    }
  }
  return true;
}

export function removeServerDownload(id: string): boolean {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task) return false;
  if (task.status === 'downloading' || task.status === 'waiting' || task.status === 'paused') {
    cancelServerDownload(id);
  }
  tasks.delete(id);
  abortControllers.delete(id);
  schedulePersist();
  return true;
}

export function retryServerDownload(id: string): ServerDownloadTask | undefined {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task) return undefined;
  if (task.status === 'downloading' || task.status === 'waiting') return task;
  for (const ep of task.episodes) {
    if (ep.status === 'error' || ep.status === 'cancelled') {
      ep.status = 'waiting';
      ep.progress = 0;
      ep.message = '重新排队';
    }
  }
  touch(task, { status: 'waiting', message: '重新排队', progress: 0 });
  if (!abortControllers.has(id)) abortControllers.set(id, new AbortController());
  schedulePump();
  return task;
}
