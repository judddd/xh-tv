/** 服务端下载任务类型（前后端共享，无 Node 依赖） */

export type MediaKind = 'movie' | 'tv';
export type ServerDownloadStatus =
  | 'waiting'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface ServerDownloadTask {
  id: string;
  title: string;
  kind: MediaKind;
  status: ServerDownloadStatus;
  progress: number;
  message?: string;
  sourceName?: string;
  outputPath?: string;
  episodes: Array<{
    url: string;
    episode?: number;
    title?: string;
    status: ServerDownloadStatus;
    progress: number;
    outputPath?: string;
    message?: string;
  }>;
  createdAt: number;
  updatedAt: number;
}
