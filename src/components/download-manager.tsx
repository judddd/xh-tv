'use client';

import { useCallback, useEffect, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { api, ApiError } from '@/lib/client-api';
import type { MediaKind, ServerDownloadTask } from '@/lib/server-download-types';
import { DownloadFolderPicker, type DownloadFolderChoice } from './download-folder-picker';
import { cn } from '@/lib/utils';

/**
 * 服务端下载管理器：
 * - 播放页 / 来源列表触发入队前先弹目录选择（默认 Movies/TVShows，可改）；
 * - ffmpeg 落盘；支持暂停 / 继续 / 取消 / 重试。
 */

const ADD_TASK_EVENT = 'libretv:add-download';
const ADD_SERIES_EVENT = 'libretv:add-series-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  kind?: MediaKind;
  episode?: number;
  season?: number;
  sourceName?: string;
  targetDir?: string;
  /** 若未带 targetDir，弹窗选择；skipPicker=true 时用默认目录 */
  skipPicker?: boolean;
  format?: 'TS' | 'MP4';
}

export interface AddSeriesDownloadPayload {
  title: string;
  kind?: MediaKind;
  sourceName?: string;
  targetDir?: string;
  skipPicker?: boolean;
  episodes: Array<{ url: string; episode?: number; season?: number; title?: string }>;
}

type Pending =
  | { type: 'episode'; payload: AddDownloadPayload }
  | { type: 'series'; payload: AddSeriesDownloadPayload };

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<ServerDownloadTask[]>([]);
  const [roots, setRoots] = useState<{ movies: string; tv: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** 展开分集详情的任务 id */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.downloadList();
      setTasks(data.tasks);
      setRoots(data.roots);
      window.dispatchEvent(new CustomEvent(DOWNLOADS_UPDATED_EVENT));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 503)) return;
    }
  }, []);

  const submitEpisode = useCallback(
    async (payload: AddDownloadPayload, choice?: DownloadFolderChoice) => {
      const kind = choice?.kind ?? payload.kind ?? 'movie';
      const targetDir =
        choice?.targetDir ??
        payload.targetDir ??
        (kind === 'tv' ? roots?.tv : roots?.movies);
      const epTitle =
        kind === 'tv' && payload.episode
          ? `${payload.title} S${String(payload.season && payload.season > 0 ? payload.season : 1).padStart(2, '0')}E${String(payload.episode).padStart(2, '0')}`
          : undefined;
      await api.downloadCreate({
        title: payload.title,
        kind,
        sourceName: payload.sourceName,
        targetDir,
        episodes: [
          {
            url: payload.url,
            episode: payload.episode,
            season: payload.season,
            title: epTitle,
          },
        ],
      });
      toast(`《${payload.title}》已加入下载`, 'success');
      await refresh();
      window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
    },
    [refresh, roots, toast]
  );

  const submitSeries = useCallback(
    async (payload: AddSeriesDownloadPayload, choice?: DownloadFolderChoice) => {
      const kind = choice?.kind ?? payload.kind ?? 'tv';
      const targetDir = choice?.targetDir ?? payload.targetDir ?? roots?.tv;
      let episodes = payload.episodes;
      if (choice?.scope === 'range' && choice.episodeFrom && choice.episodeTo) {
        const from = Math.min(choice.episodeFrom, choice.episodeTo);
        const to = Math.max(choice.episodeFrom, choice.episodeTo);
        episodes = payload.episodes.filter((e) => {
          const n = e.episode ?? 0;
          return n >= from && n <= to;
        });
        if (!episodes.length) {
          // 无 episode 字段时按数组下标（1 基）切片
          episodes = payload.episodes.slice(from - 1, to);
        }
      }
      if (!episodes.length) throw new Error('所选集数范围内没有可下载条目');
      await api.downloadCreate({
        title: payload.title,
        kind,
        sourceName: payload.sourceName,
        targetDir,
        episodes,
      });
      const rangeLabel =
        choice?.scope === 'range' && choice.episodeFrom && choice.episodeTo
          ? choice.episodeFrom === choice.episodeTo
            ? `第 ${choice.episodeFrom} 集`
            : `第 ${Math.min(choice.episodeFrom, choice.episodeTo)}–${Math.max(choice.episodeFrom, choice.episodeTo)} 集`
          : `全剧 ${episodes.length} 集`;
      toast(`《${payload.title}》${rangeLabel}已加入下载`, 'success');
      await refresh();
      window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
    },
    [refresh, roots, toast]
  );

  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      void (async () => {
        try {
          if (detail.targetDir || detail.skipPicker) {
            await submitEpisode(detail);
            return;
          }
          setPending({ type: 'episode', payload: detail });
        } catch (err) {
          toast(err instanceof Error ? err.message : '入队失败', 'error');
        }
      })();
    };

    const onSeries = (e: Event) => {
      const detail = (e as CustomEvent<AddSeriesDownloadPayload>).detail;
      if (!detail?.title || !detail.episodes?.length) return;
      void (async () => {
        try {
          if (detail.targetDir || detail.skipPicker) {
            await submitSeries(detail);
            return;
          }
          setPending({ type: 'series', payload: detail });
        } catch (err) {
          toast(err instanceof Error ? err.message : '入队失败', 'error');
        }
      })();
    };

    window.addEventListener(ADD_TASK_EVENT, onAdd);
    window.addEventListener(ADD_SERIES_EVENT, onSeries);
    return () => {
      window.removeEventListener(ADD_TASK_EVENT, onAdd);
      window.removeEventListener(ADD_SERIES_EVENT, onSeries);
    };
  }, [submitEpisode, submitSeries, toast]);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [isOpen, refresh]);

  // 有待选目录时也预拉一次 roots
  useEffect(() => {
    if (!pending || roots) return;
    void api.downloadList().then((d) => setRoots(d.roots)).catch(() => {});
  }, [pending, roots]);

  const onPickerConfirm = async (choice: DownloadFolderChoice) => {
    if (!pending) return;
    const cur = pending;
    setPending(null);
    try {
      if (cur.type === 'episode') await submitEpisode(cur.payload, choice);
      else await submitSeries(cur.payload, choice);
    } catch (err) {
      toast(err instanceof Error ? err.message : '入队失败', 'error');
    }
  };

  const onCancel = async (task: ServerDownloadTask) => {
    try {
      if (task.status === 'downloading' || task.status === 'waiting' || task.status === 'paused') {
        await api.downloadCancel(task.id);
        toast(`《${task.title}》已取消`, 'info');
      } else {
        await api.downloadRemove(task.id);
        toast(`《${task.title}》已删除记录`, 'info');
      }
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'error');
    }
  };

  const onPauseResume = async (task: ServerDownloadTask) => {
    try {
      if (task.status === 'downloading') {
        await api.downloadPause(task.id);
        toast(`《${task.title}》已暂停`, 'info');
      } else if (task.status === 'paused') {
        await api.downloadResume(task.id);
        toast(`《${task.title}》继续下载`, 'success');
      }
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'error');
    }
  };

  const onRetry = async (task: ServerDownloadTask) => {
    try {
      await api.downloadRetry(task.id);
      toast(`《${task.title}》已重新排队`, 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : '重试失败', 'error');
    }
  };

  const statusLabel: Record<ServerDownloadTask['status'], string> = {
    waiting: '排队中',
    downloading: '下载中',
    paused: '已暂停',
    completed: '已完成',
    error: '失败',
    cancelled: '已取消',
  };

  const formatSpeed = (bps?: number) => {
    if (!bps || bps <= 0) return null;
    if (bps < 1024) return `${Math.round(bps)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  };

  const phaseLabel = (phase?: string) => {
    if (phase === 'segments') return '拉片';
    if (phase === 'mux') return '封装';
    if (phase === 'verify') return '校验';
    if (phase === 'filter') return '去广告';
    if (phase === 'done') return '完成';
    return null;
  };

  const formatDuration = (sec?: number) => {
    if (!sec || sec <= 0) return null;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
  };

  const episodeStatusClass = (status: ServerDownloadTask['status']) => {
    if (status === 'completed') return 'text-accent';
    if (status === 'error' || status === 'cancelled') return 'text-amber-600 dark:text-amber-400';
    if (status === 'downloading') return 'text-content';
    return 'text-faint';
  };

  const pickerDefaultKind: MediaKind =
    pending?.type === 'series'
      ? pending.payload.kind ?? 'tv'
      : pending?.payload.kind ?? 'movie';

  return (
    <>
      <DownloadFolderPicker
        open={Boolean(pending)}
        title={pending?.payload.title || ''}
        defaultKind={pickerDefaultKind}
        allowSeries={pending?.type === 'series' && (pending.payload.episodes?.length || 0) > 1}
        episodeCount={pending?.type === 'series' ? pending.payload.episodes.length : 1}
        onClose={() => setPending(null)}
        onConfirm={(c) => void onPickerConfirm(c)}
      />

      <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-lg">
        <div className="space-y-3">
          <div className="card p-3 space-y-1">
            <p className="text-sm text-content">服务端并行拉片 + ffmpeg 封装（可暂停，显示实时速度）</p>
            <p className="text-xs text-faint">
              默认电影 → {roots?.movies || '/media/Movies'}
              <br />
              默认剧集 → {roots?.tv || '/media/TVShows'}
              <br />
              每次下载都会弹出目录选择；也可浏览 / 新建其它允许文件夹。
            </p>
          </div>

          {tasks.length === 0 && (
            <div className="py-10 text-center text-sm text-faint">
              暂无下载任务。在来源列表或播放页点击下载。
            </div>
          )}

          {tasks.map((t) => (
            <div key={t.id} className="card p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-content truncate">{t.title}</p>
                  <p className="text-xs text-faint">
                    {t.kind === 'tv' ? '剧集' : '电影'} · {statusLabel[t.status]}
                    {t.sourceName ? ` · ${t.sourceName}` : ''}
                    {t.episodes.length > 1
                      ? ` · ${t.episodes.filter((e) => e.status === 'completed').length}/${t.episodes.length} 集`
                      : ''}
                    {phaseLabel(t.phase) ? ` · ${phaseLabel(t.phase)}` : ''}
                  </p>
                  {(t.status === 'downloading' || t.status === 'paused') && formatSpeed(t.speedBps) && (
                    <p className="text-sm font-medium text-accent tabular-nums mt-0.5">
                      {formatSpeed(t.speedBps)}
                      {t.progress != null ? ` · ${t.progress}%` : ''}
                    </p>
                  )}
                  {t.message && <p className="text-xs text-muted mt-0.5 break-all">{t.message}</p>}
                  {(t.adFilter || t.episodes.some((e) => e.adFilter)) && (
                    <p
                      className={cn(
                        'text-xs mt-0.5',
                        (t.adFilter ?? t.episodes.find((e) => e.adFilter)?.adFilter)?.status ===
                          'removed'
                          ? 'text-accent'
                          : 'text-amber-600 dark:text-amber-400'
                      )}
                    >
                      {(t.adFilter ?? t.episodes.find((e) => e.adFilter)?.adFilter)?.label}
                    </p>
                  )}
                  {t.embyNotify && !t.embyNotify.skipped && (
                    <p
                      className={cn(
                        'text-xs mt-0.5',
                        t.embyNotify.ok ? 'text-accent' : 'text-amber-600 dark:text-amber-400'
                      )}
                    >
                      {t.embyNotify.message}
                    </p>
                  )}
                  {t.outputPath && t.status === 'completed' && (
                    <p className="text-xs text-faint mt-0.5 break-all">{t.outputPath}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {t.status === 'downloading' && (
                    <button
                      type="button"
                      className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                      onClick={() => void onPauseResume(t)}
                    >
                      暂停
                    </button>
                  )}
                  {t.status === 'paused' && (
                    <button
                      type="button"
                      className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                      onClick={() => void onPauseResume(t)}
                    >
                      继续
                    </button>
                  )}
                  {(t.status === 'error' || t.status === 'cancelled') && (
                    <button
                      type="button"
                      className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                      onClick={() => void onRetry(t)}
                    >
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="删除或取消下载任务"
                    className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                    onClick={() => void onCancel(t)}
                  >
                    <Icon name="close" className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {(t.status === 'downloading' ||
                t.status === 'paused' ||
                t.status === 'waiting' ||
                t.status === 'completed' ||
                t.status === 'error') && (
                <button
                  type="button"
                  className="w-full text-left group"
                  onClick={() => toggleExpanded(t.id)}
                  aria-expanded={expandedIds.has(t.id)}
                  title="点击查看每集下载与校验详情"
                >
                  <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                    <div
                      className={cn(
                        'h-full transition-all',
                        t.status === 'error' ? 'bg-amber-500' : 'bg-accent'
                      )}
                      style={{ width: `${Math.min(100, Math.max(0, t.progress))}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-faint mt-1 group-hover:text-muted">
                    {expandedIds.has(t.id) ? '收起详情' : '点击进度条查看每集下载 / 校验详情'}
                    {t.episodes.length > 0
                      ? ` · ${t.episodes.filter((e) => e.status === 'completed').length}/${t.episodes.length} 集`
                      : ''}
                  </p>
                </button>
              )}

              {expandedIds.has(t.id) && (
                <div className="rounded-lg border border-line bg-chip/40 max-h-64 overflow-y-auto divide-y divide-line">
                  {t.episodes.map((ep, idx) => {
                    const epNo =
                      ep.episode && ep.episode > 0
                        ? `E${String(ep.episode).padStart(2, '0')}`
                        : `#${idx + 1}`;
                    const season =
                      ep.season && ep.season > 0 ? `S${String(ep.season).padStart(2, '0')}` : null;
                    const dur = formatDuration(ep.verifiedDurationSec);
                    const spd = formatSpeed(ep.speedBps);
                    const phase = phaseLabel(ep.phase);
                    return (
                      <div key={`${t.id}-${idx}`} className="px-2.5 py-2 space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs text-content tabular-nums shrink-0">
                            {season ? `${season}${epNo}` : epNo}
                            {ep.title ? (
                              <span className="text-faint font-normal"> · {ep.title}</span>
                            ) : null}
                          </p>
                          <p className={cn('text-xs shrink-0 tabular-nums', episodeStatusClass(ep.status))}>
                            {statusLabel[ep.status]}
                            {ep.progress > 0 && ep.status === 'downloading' ? ` ${ep.progress}%` : ''}
                          </p>
                        </div>
                        {(phase || spd || dur || ep.adFilter || ep.message) && (
                          <p className="text-[11px] text-muted break-all">
                            {[
                              phase,
                              spd,
                              dur ? `校验时长 ${dur}` : null,
                              ep.adFilter?.status === 'removed'
                                ? ep.adFilter.label
                                : ep.adFilter?.status === 'none' && ep.status === 'completed'
                                  ? '无广告标记'
                                  : null,
                              ep.message && ep.message !== ep.adFilter?.label ? ep.message : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                        {ep.status === 'downloading' && (
                          <div className="h-1 rounded-full bg-chip overflow-hidden">
                            <div
                              className="h-full bg-accent/80 transition-all"
                              style={{ width: `${Math.min(100, Math.max(0, ep.progress))}%` }}
                            />
                          </div>
                        )}
                        {ep.outputPath && (ep.status === 'completed' || ep.status === 'error') && (
                          <p className="text-[10px] text-faint break-all">{ep.outputPath}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </Drawer>
    </>
  );
}

export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

export function enqueueSeriesDownload(payload: AddSeriesDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_SERIES_EVENT, { detail: payload }));
}

export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}
