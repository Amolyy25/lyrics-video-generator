import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { downloadFromYoutube } from "./services/download.js";
import { fetchLyrics } from "./services/lyrics.js";
import { translateLyrics, VALID_TRANSLATION_STYLES } from "./services/translate.js";
import { generateVideo } from "./services/video.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "outputs");
const ASSETS_DIR = path.resolve(__dirname, "assets"); // persistent audio/cover/translations per track
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(null, true);
    },
  })
);

app.use(express.static(FRONTEND_DIR));

// Base hash: identifies the (artist, title) pair — asset bundle is keyed on this.
function baseHash(artist, title) {
  return crypto
    .createHash("sha1")
    .update(`${artist.toLowerCase()}::${title.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

// Render hash: includes every render-affecting parameter.
function renderHash(base, duration, style, startTime, translate, translationStyle, lyricOffset) {
  const key = `${base}::${duration}::${startTime ?? "auto"}::off=${lyricOffset ?? 0}::tr=${
    translate ? 1 : 0
  }::ts=${translationStyle || "none"}::${JSON.stringify(style || {})}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

const MIN_DURATION = 5;
const MAX_DURATION = 90;

function clampDuration(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 15;
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(n)));
}

const VALID_COLORS = [
  "white", "neon", "pink", "cyan", "yellow", "red",
  "sunset", "ocean", "matrix", "fire", "holo", "gold", "ice", "purple",
];

function normalizeStyle(raw = {}) {
  const textColor = VALID_COLORS.includes(raw.textColor) ? raw.textColor : "white";
  const revealSpeed = ["slow", "normal", "fast", "turbo"].includes(raw.revealSpeed)
    ? raw.revealSpeed
    : "normal";
  const animation = ["smooth", "punchy", "flat"].includes(raw.animation)
    ? raw.animation
    : "smooth";
  const glow = raw.glow !== false; // default true
  return { textColor, revealSpeed, animation, glow };
}

function normalizeStartTime(raw) {
  if (raw == null || raw === "" || raw === "auto") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(0, Math.round(n * 100) / 100);
}

function normalizeTranslationStyle(raw) {
  return VALID_TRANSLATION_STYLES.includes(raw) ? raw : "rap-street";
}

function normalizeLyricOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-5, Math.min(5, Math.round(n * 10) / 10));
}

async function ensureDirs() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(ASSETS_DIR, { recursive: true });
}

function assetPaths(base) {
  const dir = path.join(ASSETS_DIR, base);
  return {
    dir,
    audio: path.join(dir, "audio.mp3"),
    cover: path.join(dir, "cover.jpg"),
    meta: path.join(dir, "meta.json"),
  };
}

async function assetsExist(base) {
  const { audio, meta } = assetPaths(base);
  try {
    await fs.access(audio);
    await fs.access(meta);
    return true;
  } catch {
    return false;
  }
}

function logPipelineError(label, err) {
  const msg = err.message || "unknown error";
  const bar = "═".repeat(72);
  console.error(`\n╔${bar}╗`);
  console.error(`║ ${label} FAILED`.padEnd(73) + "║");
  console.error(`╠${bar}╣`);
  console.error(`║ message: ${msg}`.slice(0, 72).padEnd(73) + "║");
  console.error(`╚${bar}╝`);
  console.error(err.stack || "");
}

function errorStage(msg) {
  if (/yt-dlp/i.test(msg)) return "download";
  if (/lrclib/i.test(msg)) return "lyrics";
  if (/gemini/i.test(msg) || /grok/i.test(msg) || /translat/i.test(msg))
    return "translate";
  if (/ffmpeg/i.test(msg)) return "video";
  return "unknown";
}

// Pipeline step 1: fetch lyrics + download audio + translate (persistence)
async function acquireAssets(
  artist,
  title,
  { translate = true, translationStyle = "rap-street" } = {}
) {
  const base = baseHash(artist, title);
  const paths = assetPaths(base);
  await fs.mkdir(paths.dir, { recursive: true });

  console.log(`[assets] acquiring bundle for ${artist} - ${title} (${base})`);

  // 1. Lyrics first (for duration hint)
  console.log("[assets] fetching lyrics");
  let lyricsRes = await fetchLyrics(artist, title);
  if (lyricsRes.expectedDuration) {
    console.log(
      `[lyrics] match="${lyricsRes.matchedTrack}" by "${lyricsRes.matchedArtist}" duration=${lyricsRes.expectedDuration}s synced=${lyricsRes.hasSyncedLyrics}`
    );
  }

  // 2. Download audio, prefer duration match
  console.log("[assets] downloading audio");
  const {
    audioPath: tmpAudioPath,
    coverUrl,
    youtubeTitle,
  } = await downloadFromYoutube(artist, title, base, {
    expectedDuration: lyricsRes.expectedDuration,
    durationTolerance: 10,
  });

  // Move audio to persistent location
  await fs.rename(tmpAudioPath, paths.audio);

  // Download cover to persistent location
  if (coverUrl) {
    try {
      const res = await fetch(coverUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(paths.cover, buf);
      }
    } catch (e) {
      console.warn(`[assets] cover download failed: ${e.message}`);
    }
  }

  // Retry lyrics if empty using youtube title
  if (!lyricsRes.lines.length && youtubeTitle) {
    console.log("[lyrics] retrying with YouTube title");
    lyricsRes = await fetchLyrics(artist, title, youtubeTitle);
  }

  // 3. Translate (skipped when translate=false, e.g. French songs)
  let finalLines;
  if (translate) {
    console.log(
      `[assets] translating ${lyricsRes.lines.length} lines style="${translationStyle}" synced=${lyricsRes.hasSyncedLyrics}`
    );
    finalLines = await translateLyrics(lyricsRes.lines, { style: translationStyle });
  } else {
    console.log("[assets] translation skipped — using original lyrics");
    finalLines = lyricsRes.lines.map((l) => ({ ...l, translated: l.text }));
  }

  // 4. Persist meta bundle
  const meta = {
    artist,
    title,
    youtubeTitle,
    coverUrl,
    hasSyncedLyrics: lyricsRes.hasSyncedLyrics,
    expectedDuration: lyricsRes.expectedDuration,
    translated: translate,
    translationStyle: translate ? translationStyle : null,
    lines: finalLines,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.meta, JSON.stringify(meta, null, 2));
  console.log(`[assets] bundle saved at ${paths.dir}`);

  return { base, paths, meta };
}

async function loadAssets(base) {
  const paths = assetPaths(base);
  const meta = JSON.parse(await fs.readFile(paths.meta, "utf8"));
  return { paths, meta };
}

async function renderFromAssets({ base, paths, meta, duration, style, startTime, lyricOffset }) {
  await ensureDirs();
  const rh = renderHash(
    base,
    duration,
    style,
    startTime,
    !!meta.translated,
    meta.translationStyle,
    lyricOffset
  );
  const outputName = `${base}-${rh}`;
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp4`);

  try {
    await fs.access(outputPath);
    console.log(`[render] cache hit ${outputName}.mp4`);
    return { outputName, cached: true };
  } catch {}

  console.log(`[render] generating ${outputName}.mp4`);
  await generateVideo({
    audioPath: paths.audio,
    coverPath: paths.cover,
    coverUrl: meta.coverUrl,
    lines: meta.lines,
    hasSyncedLyrics: meta.hasSyncedLyrics,
    outputName,
    maxClipSeconds: duration,
    startTime,
    lyricOffset,
    style,
  });
  return { outputName, cached: false };
}

function buildPayload({ base, outputName, meta, duration, style, startTime, lyricOffset, cached }) {
  return {
    base,
    videoUrl: `/api/video/${outputName}.mp4?t=${Date.now()}`,
    lyrics: meta.lines.map((l) => ({ time: l.time, text: l.text })),
    lyricsTranslated: meta.lines.map((l) => ({
      time: l.time,
      text: l.translated,
    })),
    coverUrl: meta.coverUrl,
    youtubeTitle: meta.youtubeTitle,
    hasSyncedLyrics: meta.hasSyncedLyrics,
    translated: !!meta.translated,
    translationStyle: meta.translationStyle || null,
    duration,
    startTime,
    lyricOffset,
    style,
    cached,
  };
}

// POST /api/generate — full pipeline (or reuse cached assets if artist+title known)
app.post("/api/generate", async (req, res) => {
  const { artist, title } = req.body || {};
  if (!artist || !title) {
    return res.status(400).json({ error: "artist and title are required" });
  }
  const duration = clampDuration(req.body.duration);
  const style = normalizeStyle(req.body.style);
  const startTime = normalizeStartTime(req.body.startTime);
  const lyricOffset = normalizeLyricOffset(req.body.lyricOffset);
  const translate = req.body.translate !== false; // default true
  const translationStyle = normalizeTranslationStyle(req.body.translationStyle);

  try {
    await ensureDirs();
    const base = baseHash(artist, title);

    let meta, paths;
    if (await assetsExist(base)) {
      console.log(`[assets] reuse existing bundle for ${base}`);
      const loaded = await loadAssets(base);
      meta = loaded.meta;
      paths = loaded.paths;

      // Re-translate if either the toggle OR the style changed
      const styleChanged =
        translate && meta.translationStyle !== translationStyle;
      const toggleChanged = meta.translated !== translate;
      if (toggleChanged || styleChanged) {
        console.log(
          `[assets] translation refresh (toggle=${toggleChanged} style=${styleChanged})`
        );
        const sourceLines = meta.lines.map((l) => ({ time: l.time, text: l.text }));
        const newLines = translate
          ? await translateLyrics(sourceLines, { style: translationStyle })
          : sourceLines.map((l) => ({ ...l, translated: l.text }));
        meta.lines = newLines;
        meta.translated = translate;
        meta.translationStyle = translate ? translationStyle : null;
        meta.updatedAt = new Date().toISOString();
        await fs.writeFile(paths.meta, JSON.stringify(meta, null, 2));
      }
    } else {
      const acquired = await acquireAssets(artist, title, {
        translate,
        translationStyle,
      });
      meta = acquired.meta;
      paths = acquired.paths;
    }

    const { outputName, cached } = await renderFromAssets({
      base,
      paths,
      meta,
      duration,
      style,
      startTime,
      lyricOffset,
    });

    return res.json(buildPayload({ base, outputName, meta, duration, style, startTime, lyricOffset, cached }));
  } catch (err) {
    logPipelineError(`GENERATE ${artist} — ${title}`, err);
    const msg = err.message || "unknown error";
    return res.status(/timeout/i.test(msg) ? 504 : 500).json({
      error: msg,
      stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
      stage: errorStage(msg),
    });
  }
});

// POST /api/regenerate — re-render with new style/duration using cached assets
app.post("/api/regenerate", async (req, res) => {
  const { base } = req.body || {};
  if (!base || !/^[a-f0-9]{8,}$/.test(base)) {
    return res.status(400).json({ error: "valid base hash is required" });
  }

  const duration = clampDuration(req.body.duration);
  const style = normalizeStyle(req.body.style);
  const startTime = normalizeStartTime(req.body.startTime);
  const lyricOffset = normalizeLyricOffset(req.body.lyricOffset);
  const translate = req.body.translate !== false;
  const translationStyle = normalizeTranslationStyle(req.body.translationStyle);

  try {
    if (!(await assetsExist(base))) {
      return res.status(404).json({
        error: "no cached assets for this base. Call /api/generate first.",
      });
    }

    const { paths, meta } = await loadAssets(base);

    const styleChanged = translate && meta.translationStyle !== translationStyle;
    const toggleChanged = meta.translated !== translate;
    if (toggleChanged || styleChanged) {
      console.log(
        `[regen] translation refresh (toggle=${toggleChanged} style=${styleChanged})`
      );
      const sourceLines = meta.lines.map((l) => ({ time: l.time, text: l.text }));
      const newLines = translate
        ? await translateLyrics(sourceLines, { style: translationStyle })
        : sourceLines.map((l) => ({ ...l, translated: l.text }));
      meta.lines = newLines;
      meta.translated = translate;
      meta.translationStyle = translate ? translationStyle : null;
      meta.updatedAt = new Date().toISOString();
      await fs.writeFile(paths.meta, JSON.stringify(meta, null, 2));
    }

    const { outputName, cached } = await renderFromAssets({
      base, paths, meta, duration, style, startTime,
    });

    return res.json(buildPayload({ base, outputName, meta, duration, style, startTime, cached }));
  } catch (err) {
    logPipelineError(`REGENERATE ${base}`, err);
    const msg = err.message || "unknown error";
    return res.status(500).json({
      error: msg,
      stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
      stage: "video",
    });
  }
});

// POST /api/retranslate — rerun translation with higher variance, then regenerate
app.post("/api/retranslate", async (req, res) => {
  const { base } = req.body || {};
  if (!base || !/^[a-f0-9]{8,}$/.test(base)) {
    return res.status(400).json({ error: "valid base hash is required" });
  }

  const duration = clampDuration(req.body.duration);
  const style = normalizeStyle(req.body.style);
  const startTime = normalizeStartTime(req.body.startTime);
  const lyricOffset = normalizeLyricOffset(req.body.lyricOffset);
  const translationStyle = normalizeTranslationStyle(req.body.translationStyle);

  try {
    if (!(await assetsExist(base))) {
      return res.status(404).json({
        error: "no cached assets for this base. Call /api/generate first.",
      });
    }

    const { paths, meta } = await loadAssets(base);

    console.log(`[retranslate] rerunning translation style="${translationStyle}"`);
    const sourceLines = meta.lines.map((l) => ({ time: l.time, text: l.text }));
    const retranslated = await translateLyrics(sourceLines, { style: translationStyle });

    meta.lines = retranslated;
    meta.translated = true;
    meta.translationStyle = translationStyle;
    meta.updatedAt = new Date().toISOString();
    await fs.writeFile(paths.meta, JSON.stringify(meta, null, 2));

    // Force fresh render (bypass cache by adding timestamp seed to style)
    const { outputName, cached } = await renderFromAssets({
      base,
      paths,
      meta,
      duration,
      style,
      startTime,
      lyricOffset,
    });

    return res.json(buildPayload({ base, outputName, meta, duration, style, startTime, lyricOffset, cached }));
  } catch (err) {
    logPipelineError(`RETRANSLATE ${base}`, err);
    return res.status(500).json({
      error: err.message || "unknown error",
      stage: "translate",
    });
  }
});

app.get("/api/video/:filename", async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-f0-9-]{8,}\.mp4$/.test(filename)) {
    return res.status(400).json({ error: "invalid filename" });
  }
  const full = path.join(OUTPUT_DIR, filename);
  try {
    await fs.access(full);
    res.sendFile(full);
  } catch {
    res.status(404).json({ error: "video not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`lyric-video-gen running on http://localhost:${PORT}`);
});
