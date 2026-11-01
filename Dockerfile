# ---- 构建阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
ENV DOWNLOAD_MOVIES_DIR=/media/Movies
ENV DOWNLOAD_TV_DIR=/media/TVShows
ENV DOWNLOAD_ALLOW_ROOTS=/media
ENV DOWNLOAD_STATE_FILE=/data/state/downloads.json
ENV DOWNLOAD_CONCURRENCY=2
ENV DOWNLOAD_RETRIES=3
# 代理拉流超时放宽：整集分片经 /api/proxy 时默认 8s 容易中断
ENV REQUEST_TIMEOUT=30000
ENV MAX_RETRIES=3

# ffmpeg：服务端 HLS→MP4 转封装（copy 流，可播）
RUN apk add --no-cache ffmpeg \
  && mkdir -p /media/Movies /media/TVShows /data/state \
  && addgroup -S nodejs && adduser -S nextjs -G nodejs \
  && chown -R nextjs:nodejs /data /media

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# 挂载宿主机媒体库时 UID 常与 nextjs 不一致，本地 NAS 场景用 root 写盘
USER root

EXPOSE 8080
CMD ["node", "server.js"]
