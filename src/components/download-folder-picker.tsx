'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client-api';
import type { MediaKind } from '@/lib/server-download-types';
import { Icon } from './icon';
import { useFocusTrap } from './use-focus-trap';
import { useToast } from './toast';
import { cn } from '@/lib/utils';

export interface DownloadFolderChoice {
  targetDir: string;
  kind: MediaKind;
  /** all: 全剧；range: episodeFrom..episodeTo（1 基，含两端） */
  scope: 'all' | 'range';
  episodeFrom?: number;
  episodeTo?: number;
}

interface Props {
  open: boolean;
  title: string;
  /** 根据片源自动推断的默认类型 */
  defaultKind: MediaKind;
  /** 是否显示集数范围（多集时） */
  allowSeries?: boolean;
  episodeCount?: number;
  onConfirm: (choice: DownloadFolderChoice) => void;
  onClose: () => void;
}

/**
 * 下载前选目录弹窗：
 * - 默认 Movies / TVShows；
 * - 可浏览允许根下任意子文件夹，也可手输路径、新建文件夹；
 * - 多集时可「全剧」或指定起止集。
 */
export function DownloadFolderPicker({
  open,
  title,
  defaultKind,
  allowSeries = false,
  episodeCount = 1,
  onConfirm,
  onClose,
}: Props) {
  const { toast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);
  const [kind, setKind] = useState<MediaKind>(defaultKind);
  const [scope, setScope] = useState<'all' | 'range'>(allowSeries ? 'all' : 'range');
  const [epFrom, setEpFrom] = useState(1);
  const [epTo, setEpTo] = useState(Math.max(1, episodeCount));
  const [roots, setRoots] = useState<{ movies: string; tv: string } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [customPath, setCustomPath] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (path?: string | null) => {
    setLoading(true);
    try {
      const data = await api.downloadBrowse(path || undefined);
      setRoots(data.roots);
      setCurrent(data.current);
      setParent(data.parent);
      setDirs(data.dirs);
      if (!path) {
        const def = defaultKind === 'tv' ? data.roots.tv : data.roots.movies;
        setCustomPath(def);
        setCurrent(def);
        const inner = await api.downloadBrowse(def);
        setCurrent(inner.current);
        setParent(inner.parent);
        setDirs(inner.dirs);
        setCustomPath(inner.current || def);
      } else if (data.current) {
        setCustomPath(data.current);
      }
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 401 || err.status === 503))) {
        toast(err instanceof Error ? err.message : '浏览目录失败', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [defaultKind, toast]);

  useEffect(() => {
    if (!open) return;
    setKind(defaultKind);
    setScope(allowSeries ? 'all' : 'range');
    setEpFrom(1);
    setEpTo(Math.max(1, episodeCount));
    void load(null);
  }, [open, defaultKind, allowSeries, episodeCount, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const applyKindDefault = (next: MediaKind) => {
    setKind(next);
    const def = next === 'tv' ? roots?.tv : roots?.movies;
    if (def) void load(def);
  };

  const clampRange = () => {
    const max = Math.max(1, episodeCount);
    let from = Math.min(max, Math.max(1, Math.floor(epFrom) || 1));
    let to = Math.min(max, Math.max(1, Math.floor(epTo) || 1));
    if (from > to) [from, to] = [to, from];
    return { from, to };
  };

  const confirm = () => {
    const target = customPath.trim();
    if (!target) {
      toast('请选择或输入保存目录', 'error');
      return;
    }
    if (allowSeries && scope === 'range') {
      const { from, to } = clampRange();
      onConfirm({
        targetDir: target,
        kind,
        scope: 'range',
        episodeFrom: from,
        episodeTo: to,
      });
      return;
    }
    onConfirm({
      targetDir: target,
      kind,
      scope: allowSeries ? 'all' : 'range',
      episodeFrom: allowSeries ? 1 : 1,
      episodeTo: allowSeries ? episodeCount : 1,
    });
  };

  const createFolder = async () => {
    if (!newFolder.trim() || !current) return;
    try {
      const res = await api.downloadMkdir(current, newFolder.trim());
      setNewFolder('');
      toast('文件夹已创建', 'success');
      await load(res.path);
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败', 'error');
    }
  };

  const rangePreview = (() => {
    if (!allowSeries || scope !== 'range') return null;
    const { from, to } = clampRange();
    return from === to ? `第 ${from} 集` : `第 ${from}–${to} 集（共 ${to - from + 1} 集）`;
  })();

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="选择下载目录"
        tabIndex={-1}
        className="bg-surface-raised rounded-xl w-full max-w-lg shadow-2xl outline-none animate-slide-up"
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-content truncate">选择下载目录</h3>
            <p className="text-xs text-faint truncate mt-0.5">{title}</p>
          </div>
          <button type="button" className="p-1.5 rounded-md hover:bg-hover text-muted" onClick={onClose} aria-label="关闭">
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={cn('btn-ghost btn-sm', kind === 'movie' && 'bg-accent/15 text-accent')}
              onClick={() => applyKindDefault('movie')}
            >
              电影默认目录
            </button>
            <button
              type="button"
              className={cn('btn-ghost btn-sm', kind === 'tv' && 'bg-accent/15 text-accent')}
              onClick={() => applyKindDefault('tv')}
            >
              剧集默认目录
            </button>
            {allowSeries && (
              <>
                <button
                  type="button"
                  className={cn('btn-ghost btn-sm', scope === 'all' && 'bg-accent/15 text-accent')}
                  onClick={() => setScope('all')}
                >
                  下载全剧（{episodeCount} 集）
                </button>
                <button
                  type="button"
                  className={cn('btn-ghost btn-sm', scope === 'range' && 'bg-accent/15 text-accent')}
                  onClick={() => setScope('range')}
                >
                  选择集数范围
                </button>
              </>
            )}
          </div>

          {allowSeries && scope === 'range' && (
            <div className="rounded-lg border border-line p-3 space-y-2">
              <p className="text-xs text-faint">集数范围（1–{episodeCount}）</p>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted shrink-0">从</label>
                <input
                  type="number"
                  min={1}
                  max={episodeCount}
                  className="w-20 rounded-lg border border-line bg-chip px-2 py-1.5 text-sm text-content tabular-nums"
                  value={epFrom}
                  onChange={(e) => setEpFrom(Number(e.target.value))}
                />
                <label className="text-xs text-muted shrink-0">到</label>
                <input
                  type="number"
                  min={1}
                  max={episodeCount}
                  className="w-20 rounded-lg border border-line bg-chip px-2 py-1.5 text-sm text-content tabular-nums"
                  value={epTo}
                  onChange={(e) => setEpTo(Number(e.target.value))}
                />
                {rangePreview && <span className="text-xs text-accent ml-1">{rangePreview}</span>}
              </div>
            </div>
          )}

          <p className="text-[11px] text-faint leading-relaxed">
            下载时自动按源站广告标记（如 adjump / 可识别中插段）剔除；无标记的源会提示「可能仍有残留」，不事后裁切正片。
            剧集落盘为 Emby 结构：剧名/Season N/剧名 SxxExx.mp4（请选 TVShows 根目录；选到剧名/Season 也会自动归一，避免套娃）。
          </p>

          <div>
            <label className="text-xs text-faint block mb-1">保存路径（可改）</label>
            <input
              className="w-full rounded-lg border border-line bg-chip px-3 py-2 text-sm text-content"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="/media/Movies"
            />
            <p className="text-[11px] text-faint mt-1">
              默认：电影 {roots?.movies || '/media/Movies'} · 剧集 {roots?.tv || '/media/TVShows'}
              。也可点下面文件夹浏览，或直接输入其它允许路径。
            </p>
          </div>

          <div className="rounded-lg border border-line overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-chip border-b border-line">
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!parent && !current}
                onClick={() => void load(parent)}
              >
                上级
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => void load(null)}>
                根目录
              </button>
              <span className="text-xs text-faint truncate flex-1">{current || '选择根目录'}</span>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {loading && <p className="text-xs text-faint p-3">加载中…</p>}
              {!loading && dirs.length === 0 && (
                <p className="text-xs text-faint p-3">此目录下没有子文件夹</p>
              )}
              {!loading &&
                dirs.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm hover:bg-accent/10 border-b border-line last:border-0',
                      customPath === d.path ? 'bg-accent/15 text-accent' : 'text-content'
                    )}
                    onClick={() => {
                      setCustomPath(d.path);
                      void load(d.path);
                    }}
                  >
                    📁 {d.name}
                  </button>
                ))}
            </div>
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-line bg-chip px-3 py-2 text-sm text-content"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              placeholder="在当前目录新建文件夹名"
            />
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void createFolder()}>
              新建
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-line">
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={confirm}>
            开始下载
          </button>
        </div>
      </div>
    </div>
  );
}
