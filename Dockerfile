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

# Persist caches between runs if a volume is mounted at /app/backend/assets
VOLUME ["/app/backend/assets", "/app/backend/outputs"]

CMD ["node", "backend/index.js"]
