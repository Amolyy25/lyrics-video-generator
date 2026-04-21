# Backend container for Railway / Fly.io / Render / self-hosted.
# Includes Node 20, ffmpeg, yt-dlp (via pip), and sharp native deps.

FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      curl \
      fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir yt-dlp \
  && yt-dlp --version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY backend ./backend
COPY frontend ./frontend

EXPOSE 3000

# On Railway: attach a volume via the UI (Settings → Volumes) on /app/backend/assets
# to persist audio/cover/translations between deploys. outputs/ (mp4) is disposable cache.

CMD ["node", "backend/index.js"]
