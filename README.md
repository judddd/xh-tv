# xh-tv（LibreTV 下载增强版）

基于 [LibreTV](https://github.com/LibreSpark/LibreTV) 2.21.0，增加服务端 ffmpeg 下载、目录选择、全剧下载与暂停。

## 功能

- 搜索结果每个来源旁可下载（先弹目录选择）
- 播放页「下载本集 / 下载全剧」
- 默认目录：电影 `Movies`、剧集 `TVShows`（可浏览/新建其它允许文件夹）
- 下载管理：进度、暂停/继续、取消、重试
- 产出标准 MP4（ffmpeg `-c copy`），可直接播放

## 快速启动

```bash
cp .env.example .env
# 编辑 .env 设置 PASSWORD；可选 MEDIA_ROOT=你的媒体库根目录

docker compose up -d --build
# http://localhost:8080
```

默认把宿主机 `${MEDIA_ROOT:-/Volumes/extend/大眼橙}` 挂到容器 `/media`。

## 环境变量（下载相关）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOWNLOAD_MOVIES_DIR` | `/media/Movies` | 电影默认目录 |
| `DOWNLOAD_TV_DIR` | `/media/TVShows` | 剧集默认目录 |
| `DOWNLOAD_ALLOW_ROOTS` | `/media` | 可选手动路径的允许根（逗号分隔） |
| `DOWNLOAD_STATE_FILE` | `/data/state/downloads.json` | 任务状态持久化 |
| `DOWNLOAD_CONCURRENCY` | `2` | 同时下载任务数 |
| `DOWNLOAD_RETRIES` | `3` | 单集失败重试次数 |

## 许可证

AGPL-3.0-or-later（继承上游 LibreTV）
