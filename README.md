# xh-tv（LibreTV 下载增强版）

基于 [LibreTV](https://github.com/LibreSpark/LibreTV) 2.21.0，增加服务端 ffmpeg 下载、目录选择、全剧下载与暂停。

## 功能

- 搜索结果每个来源旁可下载（先弹目录选择）
- 播放页「下载本集 / 下载全剧」
- 默认目录：电影 `Movies`、剧集 `TVShows`（可浏览/新建其它允许文件夹）
- 剧集落盘：`TVShows/剧名/Season N/剧名 SxxExx.mp4`（Emby 结构）
- 下载管理：进度、暂停/继续、取消、重试
- 产出标准 MP4（ffmpeg `-c copy`），可直接播放
- 下载完成可通知 Emby 增量刷新（失败仅提示）

## 快速启动

```bash
cp .env.example .env
# 编辑 .env 设置 PASSWORD；可选 MEDIA_ROOT=你的媒体库根目录
# 若要对 Emby 刷库：填 EMBY_URL / EMBY_API_KEY（见下方）

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
| `DOWNLOAD_EPISODE_CONCURRENCY` | `10` | 同一剧集任务内并行路数 |
| `DOWNLOAD_RETRIES` | `3` | 单集失败重试次数 |
| `EMBY_URL` | （空=跳过） | Emby 地址，容器内可达，如 `http://host.docker.internal:8096` |
| `EMBY_API_KEY` | （空=跳过） | Emby「API 密钥」页面生成的 Access Token |
| `EMBY_PATH_MAP` | `/media/Movies:/mnt/movies,/media/TVShows:/mnt/tv` | LibreTV 路径→Emby 路径 |

## Emby API Key 怎么建、填什么

1. 管理员登录 Emby → **设置 → API 密钥**（或打开 `http://localhost:8096/web/index.html#!/apikeys`）
2. **新建 API 密钥**，应用名填 `LibreTV` 即可
3. 复制生成的 **Access Token**（通常 32 位十六进制）到 `.env` 的 `EMBY_API_KEY=`
4. `EMBY_API_KEY` 填的就是这串 Token，**不是**账号密码，也不是 Server Id
5. 改完 `.env` 后 `docker compose up -d` 重启生效

下载成功后会 `POST /emby/Library/Media/Updated`；失败只在下载管理显示提示，不影响文件。

部署侧更细的说明见同机 `libretv/README.md`。

## 许可证

AGPL-3.0-or-later（继承上游 LibreTV）
