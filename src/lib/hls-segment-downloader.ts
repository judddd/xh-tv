/**
 * HLS 分片并行下载（Node fetch + 可选 AES-128 解密）→ 本地明文 playlist。
 * ffmpeg 只负责本地封装，不再跨网串行拉 TS。
 */

import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { globalSegmentSemaphore } from './download-scheduler';

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SEGMENT_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.DOWNLOAD_SEGMENT_CONCURRENCY || '12', 10) || 12
);
const SEGMENT_RETRIES = Math.max(1, parseInt(process.env.DOWNLOAD_SEGMENT_RETRIES || '3', 10) || 3);

export type HlsCryptoMethod = 'NONE' | 'AES-128' | 'SAMPLE-AES' | 'OTHER';

export interface HlsKeyInfo {
  method: HlsCryptoMethod;
  uri?: string;
  iv?: Buffer;
}

export interface HlsSegment {
  index: number;
  url: string;
  duration: number;
  key: HlsKeyInfo;
  mediaSequence: number;
  byteRange?: { offset: number; length: number };
}

export interface ParsedMediaPlaylist {
  segments: HlsSegment[];
  targetDuration: number;
  version: number;
  mediaSequence: number;
  /** 是否可用自研并行引擎（仅 NONE / AES-128） */
  supportsParallel: boolean;
  unsupportedReason?: string;
  totalDuration: number;
}

export interface SegmentProgress {
  done: number;
  total: number;
  bytesTotal: number;
  speedBps: number;
  phase: 'segments' | 'mux';
}

export interface DownloadSegmentsResult {
  workDir: string;
  localPlaylist: string;
  segmentFiles: string[];
  totalDuration: number;
  bytesTotal: number;
}

function parseIv(hexOrRaw: string | undefined, mediaSeq: number): Buffer {
  if (hexOrRaw) {
    const h = hexOrRaw.startsWith('0x') || hexOrRaw.startsWith('0X') ? hexOrRaw.slice(2) : hexOrRaw;
    if (/^[0-9a-fA-F]+$/.test(h) && h.length <= 32) {
      return Buffer.from(h.padStart(32, '0'), 'hex');
    }
  }
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(mediaSeq >>> 0, 12);
  return iv;
}

function parseMethod(raw: string | undefined): HlsCryptoMethod {
  const m = (raw || 'NONE').toUpperCase();
  if (m === 'NONE') return 'NONE';
  if (m === 'AES-128') return 'AES-128';
  if (m === 'SAMPLE-AES' || m.startsWith('SAMPLE-AES')) return 'SAMPLE-AES';
  return 'OTHER';
}

/** 解析已绝对化的 media playlist */
export function parseMediaPlaylist(content: string): ParsedMediaPlaylist {
  const lines = content.split(/\r?\n/);
  let targetDuration = 10;
  let version = 3;
  let mediaSequence = 0;
  let pendingDuration = 0;
  let pendingRange: { offset: number; length: number } | undefined;
  let currentKey: HlsKeyInfo = { method: 'NONE' };
  let seq = 0;
  const segments: HlsSegment[] = [];
  let unsupportedReason: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) {
      version = parseInt(line.slice('#EXT-X-VERSION:'.length), 10) || 3;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.slice('#EXT-X-TARGETDURATION:'.length), 10) || targetDuration;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      seq = mediaSequence;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = parseMethod(line.match(/METHOD=([^,]+)/i)?.[1]);
      const uri = line.match(/URI="([^"]+)"/i)?.[1];
      const ivRaw = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/i)?.[1];
      currentKey = {
        method,
        uri,
        iv: ivRaw ? parseIv(ivRaw, 0) : undefined,
      };
      if (method === 'SAMPLE-AES' || method === 'OTHER') {
        unsupportedReason = `不支持的加密：${method}`;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const body = line.slice('#EXT-X-BYTERANGE:'.length);
      const [lenStr, offStr] = body.split('@');
      const length = parseInt(lenStr, 10);
      const offset = offStr != null ? parseInt(offStr, 10) : 0;
      if (Number.isFinite(length) && length > 0) pendingRange = { offset, length };
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    const mediaSeq = seq;
    const key: HlsKeyInfo = {
      method: currentKey.method,
      uri: currentKey.uri,
      iv: currentKey.iv ?? (currentKey.method === 'AES-128' ? parseIv(undefined, mediaSeq) : undefined),
    };
    segments.push({
      index: segments.length,
      url: line,
      duration: pendingDuration,
      key,
      mediaSequence: mediaSeq,
      byteRange: pendingRange,
    });
    seq += 1;
    pendingDuration = 0;
    pendingRange = undefined;
  }

  const totalDuration = segments.reduce((s, x) => s + x.duration, 0);
  const supportsParallel = !unsupportedReason && segments.every((s) => s.key.method === 'NONE' || s.key.method === 'AES-128');
  if (!supportsParallel && !unsupportedReason) unsupportedReason = '分片加密类型不支持并行引擎';

  return {
    segments,
    targetDuration,
    version,
    mediaSequence,
    supportsParallel,
    unsupportedReason,
    totalDuration,
  };
}

async function fetchBuffer(
  url: string,
  signal: AbortSignal,
  byteRange?: { offset: number; length: number }
): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'User-Agent': UA,
  };
  if (byteRange) {
    const end = byteRange.offset + byteRange.length - 1;
    headers.Range = `bytes=${byteRange.offset}-${end}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function aes128Decrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function segFileName(index: number): string {
  return `seg_${String(index).padStart(5, '0')}.ts`;
}

class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];
  private total = 0;

  add(n: number): void {
    this.total += n;
    const now = Date.now();
    this.samples.push({ t: now, bytes: this.total });
    const cut = now - 3000;
    while (this.samples.length > 1 && this.samples[0].t < cut) this.samples.shift();
  }

  get bytesTotal(): number {
    return this.total;
  }

  get speedBps(): number {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (b.bytes - a.bytes) / dt);
  }
}

export function formatSpeedBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function writeLocalPlainPlaylist(
  workDir: string,
  parsed: ParsedMediaPlaylist,
  present: boolean[]
): string {
  const target = Math.max(
    1,
    Math.ceil(Math.max(...parsed.segments.map((s) => s.duration), parsed.targetDuration))
  );
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${Math.min(parsed.version || 3, 3)}`,
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (const seg of parsed.segments) {
    if (!present[seg.index]) continue;
    lines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
    lines.push(segFileName(seg.index));
  }
  lines.push('#EXT-X-ENDLIST');
  const out = path.join(workDir, 'index.local.m3u8');
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  return out;
}

export interface DownloadHlsSegmentsOptions {
  workDir: string;
  signal: AbortSignal;
  concurrency?: number;
  resume?: boolean;
  /** 暂停门闩：返回后继续；取消则抛错 */
  waitIfPaused?: () => Promise<void>;
  onProgress?: (p: SegmentProgress) => void;
}

/**
 * 并行下载分片到 workDir，写出明文 local playlist。
 */
export async function downloadHlsSegments(
  playlistText: string,
  opts: DownloadHlsSegmentsOptions
): Promise<DownloadSegmentsResult> {
  const parsed = parseMediaPlaylist(playlistText);
  if (!parsed.segments.length) throw new Error('播放列表无分片');
  if (!parsed.supportsParallel) {
    throw new Error(parsed.unsupportedReason || '当前清单不支持并行分片引擎');
  }

  const workDir = opts.workDir;
  fs.mkdirSync(workDir, { recursive: true });
  const concurrency = Math.max(1, opts.concurrency ?? SEGMENT_CONCURRENCY);
  const keyCache = new Map<string, Buffer>();
  const meter = new SpeedMeter();
  const present = new Array<boolean>(parsed.segments.length).fill(false);
  let done = 0;

  // 断点：已有完整文件视为完成
  for (const seg of parsed.segments) {
    const fp = path.join(workDir, segFileName(seg.index));
    if (opts.resume !== false && fs.existsSync(fp) && fs.statSync(fp).size > 0) {
      present[seg.index] = true;
      done += 1;
      meter.add(fs.statSync(fp).size);
    }
  }

  const report = () => {
    opts.onProgress?.({
      done,
      total: parsed.segments.length,
      bytesTotal: meter.bytesTotal,
      speedBps: meter.speedBps,
      phase: 'segments',
    });
  };
  report();

  const pending = parsed.segments.filter((s) => !present[s.index]);
  let cursor = 0;
  let firstErr: unknown;

  const worker = async () => {
    while (true) {
      if (opts.signal.aborted) throw new Error('已取消');
      if (opts.waitIfPaused) await opts.waitIfPaused();
      if (firstErr) return;
      const my = cursor++;
      if (my >= pending.length) return;
      const seg = pending[my];
      const fp = path.join(workDir, segFileName(seg.index));
      const tmp = `${fp}.part`;

      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          if (opts.signal.aborted) throw new Error('已取消');
          if (opts.waitIfPaused) await opts.waitIfPaused();

          await globalSegmentSemaphore.run(async () => {
            let body = await fetchBuffer(seg.url, opts.signal, seg.byteRange);
            if (seg.key.method === 'AES-128') {
              if (!seg.key.uri) throw new Error(`分片 ${seg.index} 缺少 KEY URI`);
              let keyBuf = keyCache.get(seg.key.uri);
              if (!keyBuf) {
                keyBuf = await fetchBuffer(seg.key.uri, opts.signal);
                if (keyBuf.length !== 16) {
                  // 有的 key 服务多返回；取前 16
                  if (keyBuf.length > 16) keyBuf = keyBuf.subarray(0, 16);
                  else throw new Error(`KEY 长度异常：${keyBuf.length}`);
                }
                keyCache.set(seg.key.uri, keyBuf);
              }
              const iv = seg.key.iv ?? parseIv(undefined, seg.mediaSequence);
              body = aes128Decrypt(body, keyBuf, iv);
            }
            fs.writeFileSync(tmp, body);
            fs.renameSync(tmp, fp);
            meter.add(body.length);
          }, opts.signal);

          present[seg.index] = true;
          done += 1;
          report();
          break;
        } catch (err) {
          try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          if (opts.signal.aborted) throw err;
          if (attempt >= SEGMENT_RETRIES) {
            firstErr = err;
            throw err;
          }
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
  };

  const n = Math.min(concurrency, Math.max(1, pending.length));
  if (pending.length > 0) {
    const results = await Promise.allSettled(Array.from({ length: n }, () => worker()));
    if (opts.signal.aborted) throw new Error('已取消');
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected && rejected.status === 'rejected') {
      throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
    }
  }

  if (!present.every(Boolean)) {
    throw new Error(`分片不完整：${present.filter(Boolean).length}/${present.length}`);
  }

  const localPlaylist = writeLocalPlainPlaylist(workDir, parsed, present);
  return {
    workDir,
    localPlaylist,
    segmentFiles: parsed.segments.map((s) => path.join(workDir, segFileName(s.index))),
    totalDuration: parsed.totalDuration,
    bytesTotal: meter.bytesTotal,
  };
}

export function getSegmentConcurrencyDefault(): number {
  return SEGMENT_CONCURRENCY;
}
