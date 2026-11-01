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
import type {
  AdFilterInfo,
  MediaKind,
  ServerDownloadStatus,
  ServerDownloadTask,
} from './server-download-types';

export type { MediaKind, ServerDownloadStatus, ServerDownloadTask, AdFilterInfo } from './server-download-types';

export interface ServerDownloadEpisode {
  url: string;
  /** 集数（1 基）；电影可省略 */
  episode?: number;
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
const FFMPEG_RETRIES = Math.max(1, parseInt(process.env.DOWNLOAD_RETRIES || '3', 10) || 3);

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
/** 当前正在跑的 ffmpeg，用于暂停（SIGSTOP）/继续（SIGCONT） */
const runningProcs = new Map<string, ChildProcess>();
let activeCount = 0;
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

function buildOutputPath(
  kind: MediaKind,
  title: string,
  episode: number | undefined,
  episodeTitle: string | undefined,
  baseDir: string
): string {
  const safe = sanitizeFilename(title);
  if (kind === 'movie') {
    return path.join(baseDir, `${safe}.mp4`);
  }
  const showDir = path.join(baseDir, safe);
  const epNum = episode && episode > 0 ? episode : 1;
  const epLabel = `E${String(epNum).padStart(2, '0')}`;
  const epName = episodeTitle ? sanitizeFilename(episodeTitle) : `${safe} - ${epLabel}`;
  return path.join(showDir, `${epName}.mp4`);
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
        ? ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data']
        : [
            '-user_agent', UA,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '30',
            '-timeout', '30000000',
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
    runningProcs.set(taskId, child);

    let errBuf = '';
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch { /* ignore */ }
    };
    if (signal.aborted) {
      onAbort();
      runningProcs.delete(taskId);
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
      runningProcs.delete(taskId);
      reject(new Error(`无法启动 ffmpeg：${err.message}`));
    });

    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      runningProcs.delete(taskId);
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

async function downloadEpisodeFile(
  taskId: string,
  url: string,
  outputPath: string,
  signal: AbortSignal,
  onProgress: (pct: number) => void,
  onAdFilter?: (info: AdFilterInfo) => void
): Promise<AdFilterInfo> {
  await assertUrlAllowed(url);
  // 必须保留 .mp4 后缀：ffmpeg 靠扩展名选 muxer，`.mp4.part` 会被当成未知格式
  const part = `${outputPath}.part.mp4`;
  // 清理残留临时文件
  try {
    if (fs.existsSync(part)) fs.unlinkSync(part);
  } catch { /* ignore */ }

  // 已存在完整文件则跳过（无法回溯当时过滤结果）
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024 * 100) {
    const skipped: AdFilterInfo = { status: 'none', label: '已存在文件，跳过（未重跑去广告）' };
    onAdFilter?.(skipped);
    onProgress(100);
    return skipped;
  }

  // 下载前：拉 m3u8 → 保守 stripAdGroups → 临时清单给 ffmpeg（不事后裁切）
  const prepared = await prepareFilteredPlaylist(url, signal);
  const adFilter: AdFilterInfo = {
    status: prepared.adFilter.status,
    label: prepared.adFilter.label,
    removedSegments: prepared.adFilter.removedSegments,
    removedSeconds: prepared.adFilter.removedSeconds,
  };
  onAdFilter?.(adFilter);

  try {
    const durationSec = await probeDurationSec(prepared.localPath, signal);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= FFMPEG_RETRIES; attempt++) {
      if (signal.aborted) throw new Error('已取消');
      try {
        await runFfmpegOnce(taskId, prepared.localPath, part, signal, onProgress, durationSec);
        fs.renameSync(part, outputPath);
        onProgress(100);
        return adFilter;
      } catch (err) {
        lastErr = err;
        try {
          if (fs.existsSync(part)) fs.unlinkSync(part);
        } catch { /* ignore */ }
        if (signal.aborted) throw new Error('已取消');
        if (attempt < FFMPEG_RETRIES) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    prepared.cleanup();
  }
}

async function runTask(task: ServerDownloadTask): Promise<void> {
  const ac = abortControllers.get(task.id);
  if (!ac) return;
  const signal = ac.signal;
  touch(task, { status: 'downloading', message: '下载中', progress: 0 });

  const total = task.episodes.length;
  let done = 0;

  try {
    for (let i = 0; i < task.episodes.length; i++) {
      if (signal.aborted) throw new Error('已取消');
      const ep = task.episodes[i];
      if (ep.status === 'completed' && ep.outputPath && fs.existsSync(ep.outputPath)) {
        done += 1;
        continue;
      }
      ep.status = 'downloading';
      ep.progress = 0;
      ep.message = '下载中';
      touch(task);

      const out = ep.outputPath!;
      try {
        const adFilter = await downloadEpisodeFile(
          task.id,
          ep.url,
          out,
          signal,
          (pct) => {
            // 暂停期间仍可能收到进度，但 UI 状态以 paused 为准
            if (task.status === 'paused') return;
            ep.progress = pct;
            const overall = Math.round(((done + pct / 100) / total) * 100);
            touch(task, {
              progress: Math.min(99, overall),
              message: `第 ${i + 1}/${total} 集 ${pct}% · ${ep.adFilter?.label || '去广告处理中'}`,
            });
          },
          (info) => {
            ep.adFilter = info;
            ep.message = info.label;
            touch(task, {
              message: `第 ${i + 1}/${total} 集 · ${info.label}`,
            });
          }
        );
        ep.adFilter = adFilter;
        ep.status = 'completed';
        ep.progress = 100;
        ep.message = adFilter.label;
        done += 1;
        touch(task, {
          status: 'downloading',
          progress: Math.round((done / total) * 100),
          message: `已完成 ${done}/${total}`,
        });
      } catch (err) {
        ep.status = signal.aborted ? 'cancelled' : 'error';
        ep.message = err instanceof Error ? err.message : String(err);
        touch(task);
        // 全剧：单集失败继续下一集，最后汇总
        if (signal.aborted) throw err;
        if (total === 1) throw err;
      }
    }

    const failed = task.episodes.filter((e) => e.status === 'error').length;
    const completed = task.episodes.filter((e) => e.status === 'completed').length;
    if (completed === 0) {
      touch(task, { status: 'error', message: failed ? '全部失败' : '无成功文件', progress: 0 });
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
    touch(task, {
      status: 'completed',
      progress: 100,
      adFilter,
      message: failed
        ? `完成 ${completed}/${total}（${failed} 集失败）· ${adFilter.label}`
        : `全部完成 · ${adFilter.label}`,
      outputPath: task.kind === 'movie' ? task.episodes[0]?.outputPath : path.dirname(task.episodes[0]?.outputPath || ''),
    });
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

/** 暂停：SIGSTOP 挂起 ffmpeg，任务状态标 paused */
export function pauseServerDownload(id: string): boolean {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task || task.status !== 'downloading') return false;
  const proc = runningProcs.get(id);
  if (proc?.pid) {
    try {
      process.kill(proc.pid, 'SIGSTOP');
    } catch {
      return false;
    }
  }
  touch(task, { status: 'paused', message: '已暂停' });
  for (const ep of task.episodes) {
    if (ep.status === 'downloading') ep.message = '已暂停';
  }
  return true;
}

/** 继续：SIGCONT 恢复 ffmpeg */
export function resumeServerDownload(id: string): boolean {
  ensureLoaded();
  const task = tasks.get(id);
  if (!task || task.status !== 'paused') return false;
  const proc = runningProcs.get(id);
  if (proc?.pid) {
    try {
      process.kill(proc.pid, 'SIGCONT');
    } catch {
      /* 进程已结束则重新排队 */
      touch(task, { status: 'waiting', message: '重新排队' });
      if (!abortControllers.has(id)) abortControllers.set(id, new AbortController());
      schedulePump();
      return true;
    }
  } else {
    // 无进程（暂停时还在排队探时长等）→ 回到 downloading/waiting
    touch(task, { status: 'downloading', message: '继续下载' });
    return true;
  }
  touch(task, { status: 'downloading', message: '继续下载' });
  for (const ep of task.episodes) {
    if (ep.status === 'downloading') ep.message = '下载中';
  }
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

  // 预先校验 URL
  for (const ep of input.episodes) {
    if (!ep.url) throw new Error('存在空播放地址');
    await assertUrlAllowed(ep.url);
  }

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
      const outputPath = buildOutputPath(kind, input.title.trim(), episode, ep.title, baseDir);
      return {
        url: ep.url,
        episode,
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
