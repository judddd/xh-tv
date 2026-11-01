/** 服务端下载任务类型（前后端共享，无 Node 依赖） */

export type MediaKind = 'movie' | 'tv';
export type ServerDownloadStatus =
  | 'waiting'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled';

/** 下载前 m3u8 广告过滤结果（保守规则；未识别不等于没有广告） */
export type AdFilterStatus = 'removed' | 'none';

export interface AdFilterInfo {
  status: AdFilterStatus;
  label: string;
  removedSegments?: number;
  removedSeconds?: number;
}

export interface ServerDownloadTask {
  id: string;
  title: string;
  kind: MediaKind;
  status: ServerDownloadStatus;
  progress: number;
  message?: string;
  sourceName?: string;
  outputPath?: string;
  /** 任务级汇总：有任一集 removed 则 removed；否则 none */
  adFilter?: AdFilterInfo;
  episodes: Array<{
    url: string;
    episode?: number;
    title?: string;
    status: ServerDownloadStatus;
    progress: number;
    outputPath?: string;
    message?: string;
    adFilter?: AdFilterInfo;
  }>;
  createdAt: number;
  updatedAt: number;
}
