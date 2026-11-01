/**
 * 全局分片下载连接帽 + 简易信号量，避免多任务/多集把 CDN 打爆。
 */

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
  }

  get pending(): number {
    return this.waiters.length;
  }

  get running(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('已取消');
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        if (signal?.aborted) {
          reject(new Error('已取消'));
          return;
        }
        this.active += 1;
        resolve();
      };
      this.waiters.push(entry);
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next(); // waiter 内会 active++
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const GLOBAL_MAX = Math.max(
  1,
  parseInt(process.env.DOWNLOAD_GLOBAL_SEGMENT_CONCURRENCY || '24', 10) || 24
);

/** 进程级分片连接池 */
export const globalSegmentSemaphore = new Semaphore(GLOBAL_MAX);

export function getGlobalSegmentLimits(): { max: number; running: number; pending: number } {
  return {
    max: GLOBAL_MAX,
    running: globalSegmentSemaphore.running,
    pending: globalSegmentSemaphore.pending,
  };
}
