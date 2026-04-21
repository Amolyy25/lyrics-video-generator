import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";
import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "..", "outputs");
const TMP_DIR = path.resolve(__dirname, "..", "tmp");

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
ffmpeg.setFfmpegPath(FFMPEG_PATH);

const WIDTH = 1080;
const HEIGHT = 1920;

const VINYL_SIZE = 560;
const VINYL_X = Math.round((WIDTH - VINYL_SIZE) / 2);
const VINYL_Y = 260;
const VINYL_CENTER_X = VINYL_X + VINYL_SIZE / 2;
const VINYL_CENTER_Y = VINYL_Y + VINYL_SIZE / 2;

const LYRIC_ZONE_Y = 1000;
const LYRIC_ZONE_WIDTH = WIDTH - 120;
const LYRIC_FONT_SIZE = 72;
const LYRIC_LINE_HEIGHT = 92;
const MAX_CHARS_PER_LINE = 16;

const ADLIB_ZONE_Y = 1550;
const ADLIB_FONT_SIZE = 42;
const ADLIB_LINE_HEIGHT = 50;
const ADLIB_MAX_CHARS = 20;

const FADE_IN_SECONDS = 0.14;
const MOTION_OFFSET_PX = 10;

const NOTE_SIZE = 90;
const NOTE_ORBIT_RADIUS = VINYL_SIZE / 2 + 70;
const NOTE_CYCLE_SECONDS = 18;

const DEFAULT_CLIP_SECONDS = 15;
const INTRO_SKIP_PAD = 0.3; // start slightly before the first lyric

const REVEAL_PRESETS = {
  slow: 0.35,
  normal: 0.22,
  fast: 0.14,
  turbo: 0.08,
};

// Flat colors (single fill)
const COLOR_PRESETS = {
  white: { fill: "#ffffff" },
  neon: { fill: "#6affb8" },
  pink: { fill: "#ff3dcf" },
  cyan: { fill: "#5ad8ff" },
  yellow: { fill: "#ffe45c" },
  red: { fill: "#ff4557" },
};

// Gradient presets (linear gradient, top-left → bottom-right)
const GRADIENT_PRESETS = {
  sunset: ["#ff3dcf", "#ffe45c"],
  ocean: ["#5ad8ff", "#a78bfa"],
  matrix: ["#6affb8", "#5ad8ff"],
  fire: ["#ff4557", "#ffe45c"],
  holo: ["#ff3dcf", "#5ad8ff"],
  gold: ["#ffe45c", "#ff9a3c"],
  ice: ["#ffffff", "#5ad8ff"],
  purple: ["#a78bfa", "#ff3dcf"],
};

const ANIMATION_PRESETS = {
  smooth: { fadeIn: 0.16, offsetPx: 8, motionBlur: true },
  punchy: { fadeIn: 0.09, offsetPx: 18, motionBlur: true },
  flat: { fadeIn: 0.08, offsetPx: 0, motionBlur: false },
};

function wrapText(text, maxChars = MAX_CHARS_PER_LINE) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function tokenize(text) {
  const re = /\(([^)]+)\)|([^\s()]+)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) tokens.push({ text: m[1], isAdlib: true });
    else tokens.push({ text: m[2], isAdlib: false });
  }
  return tokens;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildLyricSvg(
  text,
  { adlib = false, color = "white", glow: glowEnabled = true } = {}
) {
  const fontSize = adlib ? ADLIB_FONT_SIZE : LYRIC_FONT_SIZE;
  const lineHeight = adlib ? ADLIB_LINE_HEIGHT : LYRIC_LINE_HEIGHT;
  const maxChars = adlib ? ADLIB_MAX_CHARS : MAX_CHARS_PER_LINE;
  const fontWeight = adlib ? 600 : 900;
  const fontStyle = adlib ? "italic" : "normal";
  const useGlow = glowEnabled && !adlib;

  // Resolve color: gradient or flat. Adlibs are always flat grey.
  const gradient = !adlib ? GRADIENT_PRESETS[color] : null;
  const flat = COLOR_PRESETS[color] || COLOR_PRESETS.white;
  let fill;
  let gradientDef = "";
  if (adlib) {
    fill = "rgba(220,220,220,0.55)";
  } else if (gradient) {
    fill = "url(#textGrad)";
    gradientDef = `
    <linearGradient id="textGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${gradient[0]}"/>
      <stop offset="100%" stop-color="${gradient[1]}"/>
    </linearGradient>`;
  } else {
    fill = flat.fill;
  }

  const wrapped = wrapText(text, maxChars);
  const totalHeight = wrapped.length * lineHeight + fontSize + 60;
  const centerX = LYRIC_ZONE_WIDTH / 2;

  const tspans = wrapped
    .map(
      (line, i) =>
        `<tspan x="${centerX}" dy="${i === 0 ? fontSize : lineHeight}" text-anchor="middle">${escapeXml(
          line
        )}</tspan>`
    )
    .join("");

  const glow = useGlow
    ? `
    <filter id="glow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>`
    : "";

  const shadowStdDev = adlib ? 1.5 : 3;
  const shadowOpacity = adlib ? 0.7 : 0.9;
  const shadowFilter = `shadow-${adlib ? "a" : "m"}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LYRIC_ZONE_WIDTH}" height="${totalHeight}">
  <defs>${gradientDef}${glow}
    <filter id="${shadowFilter}" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="3" stdDeviation="${shadowStdDev}" flood-color="black" flood-opacity="${shadowOpacity}"/>
    </filter>
  </defs>
  <g${useGlow ? ' filter="url(#glow)"' : ""}>
    <text x="0" y="20"
      font-family="Helvetica Neue, Arial, sans-serif"
      font-size="${fontSize}"
      font-weight="${fontWeight}"
      font-style="${fontStyle}"
      fill="${fill}"
      letter-spacing="${adlib ? 0 : -1}"
      filter="url(#${shadowFilter})">${tspans}</text>
  </g>
</svg>`;
}

async function renderLyricPair(text, basePath, opts) {
  const svg = buildLyricSvg(text, opts);
  const buf = Buffer.from(svg);
  await sharp(buf).png().toFile(basePath);
  if (opts.motionBlur) {
    const blurPath = basePath.replace(/\.png$/, "-blur.png");
    // Horizontal-biased blur for motion feel
    await sharp(buf).blur(12).png().toFile(blurPath);
    return { sharpPath: basePath, blurPath };
  }
  return { sharpPath: basePath, blurPath: null };
}

function buildNoteSvg(symbol) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${NOTE_SIZE}" height="${NOTE_SIZE}" viewBox="0 0 100 100">
  <defs>
    <filter id="noteGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <text x="50" y="72" font-size="80" text-anchor="middle"
    font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif"
    fill="white" filter="url(#noteGlow)">${symbol}</text>
</svg>`;
}

async function renderNotePng(symbol, outPath) {
  await sharp(Buffer.from(buildNoteSvg(symbol))).png().toFile(outPath);
  return outPath;
}

async function renderVinylPng(coverPath, outPath) {
  const size = VINYL_SIZE;
  const center = size / 2;
  const coverInnerDiameter = Math.round(size * 0.94);
  const coverOffset = Math.round((size - coverInnerDiameter) / 2);
  const holeDiameter = Math.round(size * 0.06);

  const circleMask = Buffer.from(
    `<svg width="${coverInnerDiameter}" height="${coverInnerDiameter}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${coverInnerDiameter / 2}" cy="${coverInnerDiameter / 2}" r="${coverInnerDiameter / 2}" fill="white"/>
    </svg>`
  );

  let coverBuf;
  try {
    coverBuf = await sharp(coverPath)
      .resize(coverInnerDiameter, coverInnerDiameter, { fit: "cover" })
      .composite([{ input: circleMask, blend: "dest-in" }])
      .png()
      .toBuffer();
  } catch {
    const fallback = Buffer.from(
      `<svg width="${coverInnerDiameter}" height="${coverInnerDiameter}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${coverInnerDiameter / 2}" cy="${coverInnerDiameter / 2}" r="${coverInnerDiameter / 2}" fill="#222"/>
      </svg>`
    );
    coverBuf = await sharp(fallback).png().toBuffer();
  }

  const grooves = Array.from({ length: 10 }, (_, i) => {
    const r = center - 4 - i * 3;
    return `<circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.8"/>`;
  }).join("");

  const vinylBg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="g" cx="50%" cy="50%" r="50%">
          <stop offset="70%" stop-color="#0a0a0a"/>
          <stop offset="100%" stop-color="#1c1c1c"/>
        </radialGradient>
        <filter id="vshadow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="8"/>
        </filter>
      </defs>
      <circle cx="${center}" cy="${center}" r="${center - 2}" fill="url(#g)"/>
      ${grooves}
    </svg>`
  );

  const centerHole = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${center}" cy="${center}" r="${holeDiameter / 2}" fill="#050505"/>
      <circle cx="${center}" cy="${center}" r="${holeDiameter / 2 + 2}" fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="1"/>
    </svg>`
  );

  await sharp(vinylBg)
    .composite([
      { input: coverBuf, top: coverOffset, left: coverOffset },
      { input: centerHole, top: 0, left: 0 },
    ])
    .png()
    .toFile(outPath);

  return outPath;
}

async function downloadCover(coverUrl, dest) {
  if (!coverUrl) return null;
  try {
    const res = await fetch(coverUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

function probeDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration || 0);
    });
  });
}

function buildChunksForLine(
  text,
  globalStart,
  globalEnd,
  revealSeconds,
  wordsPerState
) {
  const tokens = tokenize(text);
  const mainTokens = tokens.filter((t) => !t.isAdlib).map((t) => t.text);
  const adlibTokens = tokens.filter((t) => t.isAdlib).map((t) => t.text);
  const duration = Math.max(0.3, globalEnd - globalStart);
  const chunks = [];

  if (mainTokens.length) {
    // Build cumulative reveal states: each state reveals wordsPerState more words.
    const states = [];
    for (let i = wordsPerState; i < mainTokens.length; i += wordsPerState) {
      states.push(i);
    }
    if (!states.length || states[states.length - 1] !== mainTokens.length) {
      states.push(mainTokens.length); // ensure the final full line is shown
    }

    const perStep = Math.min(revealSeconds, duration / states.length);
    for (let i = 0; i < states.length; i++) {
      const wordCount = states[i];
      const cumulativeText = mainTokens.slice(0, wordCount).join(" ");
      const start = globalStart + i * perStep;
      const end =
        i < states.length - 1
          ? globalStart + (i + 1) * perStep
          : globalEnd;
      chunks.push({
        kind: "main",
        text: cumulativeText,
        start,
        end,
        animate: i === 0,
      });
    }
  }

  if (adlibTokens.length) {
    const perAdlib = duration / adlibTokens.length;
    for (let i = 0; i < adlibTokens.length; i++) {
      chunks.push({
        kind: "adlib",
        text: adlibTokens[i],
        start: globalStart + (i + 0.35) * perAdlib,
        end: globalStart + (i + 1) * perAdlib,
        animate: true,
      });
    }
  }

  return chunks;
}

// Choose how many words to reveal per cumulative state so that the total chunk
// count stays below the ffmpeg-safe budget. With too many inputs ffmpeg runs out
// of decoder threads / file descriptors.
const MAX_LYRIC_CHUNKS = 40;

function computeWordsPerState(lines) {
  const totalMainWords = lines.reduce((sum, l) => {
    const t = l.translated || l.text;
    return sum + tokenize(t).filter((tok) => !tok.isAdlib).length;
  }, 0);
  if (totalMainWords <= MAX_LYRIC_CHUNKS) return 1; // word-by-word
  return Math.max(1, Math.ceil(totalMainWords / MAX_LYRIC_CHUNKS));
}

function buildChunks(lines, totalDuration, hasSynced, revealSeconds) {
  if (!lines.length) return [];
  const allChunks = [];
  const wordsPerState = computeWordsPerState(lines);
  if (wordsPerState > 1) {
    console.log(
      `[video] chunk budget: grouping ${wordsPerState} words per reveal state to stay under ${MAX_LYRIC_CHUNKS} chunks`
    );
  }

  if (hasSynced) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const start = l.time;
      const end = i < lines.length - 1 ? lines[i + 1].time : totalDuration;
      const text = l.translated || l.text;
      allChunks.push(
        ...buildChunksForLine(text, start, end, revealSeconds, wordsPerState)
      );
    }
  } else {
    const slice = totalDuration / lines.length;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].translated || lines[i].text;
      allChunks.push(
        ...buildChunksForLine(
          text,
          i * slice,
          (i + 1) * slice,
          revealSeconds,
          wordsPerState
        )
      );
    }
  }
  return allChunks;
}

function planClip(lines, totalDuration, hasSynced, maxClipSeconds, startTime) {
  let startOffset;
  if (typeof startTime === "number" && startTime >= 0) {
    startOffset = Math.min(startTime, Math.max(0, totalDuration - 1));
  } else {
    // auto mode: start slightly before the first synced lyric
    startOffset =
      hasSynced && lines.length
        ? Math.max(0, lines[0].time - INTRO_SKIP_PAD)
        : 0;
  }

  const remaining = Math.max(0, totalDuration - startOffset);
  const clipDuration = Math.min(maxClipSeconds, remaining);

  return { startOffset, clipDuration };
}

function shiftAndClipChunks(chunks, startOffset, clipDuration) {
  return chunks
    .map((c) => ({
      ...c,
      start: c.start - startOffset,
      end: c.end - startOffset,
    }))
    .filter((c) => c.end > 0 && c.start < clipDuration)
    .map((c) => ({
      ...c,
      start: Math.max(0, c.start),
      end: Math.min(clipDuration, c.end),
    }));
}

function runFfmpegRaw(args, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    // On Linux, wrap in sh with ulimit bump so ffmpeg has enough file descriptors
    // for pipelines with many PNG inputs (motion blur chunks). On other platforms,
    // spawn directly.
    const isLinux = process.platform === "linux";
    const proc = isLinux
      ? spawn("sh", ["-c", 'ulimit -n 65536 2>/dev/null; exec "$@"', "--", FFMPEG_PATH, ...args])
      : spawn(FFMPEG_PATH, args);
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timeout"));
    }, timeoutMs);

    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "ffmpeg not found. Install it: `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux)."
          )
        );
      } else reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function generateVideo({
  audioPath,
  coverPath,
  coverUrl,
  lines,
  hasSyncedLyrics,
  outputName,
  maxClipSeconds = DEFAULT_CLIP_SECONDS,
  startTime = null,
  lyricOffset = 0,
  style = {},
}) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  const revealSpeed = style.revealSpeed || "normal";
  const colorName = style.textColor || "white";
  const animationName = style.animation || "smooth";
  const glowEnabled = style.glow !== false;

  const revealSeconds =
    REVEAL_PRESETS[revealSpeed] || REVEAL_PRESETS.normal;
  const anim = ANIMATION_PRESETS[animationName] || ANIMATION_PRESETS.smooth;

  console.log(
    `[video] style: color=${colorName} speed=${revealSpeed}(${revealSeconds}s) anim=${animationName} glow=${glowEnabled} startTime=${
      startTime ?? "auto"
    } lyricOffset=${lyricOffset}s`
  );

  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp4`);
  const fullDuration = await probeDuration(audioPath);
  const rawChunksUnshifted = buildChunks(
    lines,
    fullDuration,
    hasSyncedLyrics,
    revealSeconds
  );
  // Apply user-defined lyric offset (positive = lyrics appear later, negative = earlier)
  const rawChunks = rawChunksUnshifted.map((c) => ({
    ...c,
    start: c.start + lyricOffset,
    end: c.end + lyricOffset,
  }));

  const { startOffset, clipDuration } = planClip(
    lines,
    fullDuration,
    hasSyncedLyrics,
    maxClipSeconds,
    startTime
  );
  const chunks = shiftAndClipChunks(rawChunks, startOffset, clipDuration);

  console.log(
    `[video] fullAudio=${fullDuration.toFixed(1)}s → clip [${startOffset.toFixed(
      2
    )}s → +${clipDuration.toFixed(2)}s] (synced=${hasSyncedLyrics}) chunks=${chunks.length}/${rawChunks.length}`
  );

  // 1. Cover: reuse pre-cached cover if available, else download
  let coverRawPath = coverPath || null;
  if (!coverRawPath && coverUrl) {
    coverRawPath = await downloadCover(
      coverUrl,
      path.join(TMP_DIR, `${outputName}-cover-raw.jpg`)
    );
  }
  let vinylPath = null;
  if (coverRawPath) {
    vinylPath = path.join(TMP_DIR, `${outputName}-vinyl.png`);
    await renderVinylPng(coverRawPath, vinylPath);
    console.log(`[video] vinyl rendered → ${path.basename(vinylPath)}`);
  }

  // 2. Notes
  const noteSymbols = ["♪", "♫", "♬", "♩"];
  const notePaths = [];
  for (let i = 0; i < noteSymbols.length; i++) {
    const p = path.join(TMP_DIR, `${outputName}-note-${i}.png`);
    await renderNotePng(noteSymbols[i], p);
    notePaths.push(p);
  }

  // 3. Lyric PNGs (one per chunk; animated chunks also get a blurred twin for motion blur).
  // Safety: each input = ~5-10 file descriptors inside ffmpeg. With hundreds of inputs
  // we blow past the container's ulimit ("Resource temporarily unavailable"). If the
  // projected stream count is too high, auto-disable motion blur (halves animated streams).
  const projectedAnimCount = chunks.filter((c) => c.animate).length;
  const projectedStreamCount =
    1 /* audio */ + 1 /* vinyl */ + 4 /* notes */ + chunks.length + projectedAnimCount;
  const STREAM_BUDGET = 80;
  const allowMotionBlur = anim.motionBlur && projectedStreamCount <= STREAM_BUDGET;
  if (!allowMotionBlur && anim.motionBlur) {
    console.warn(
      `[video] too many streams (${projectedStreamCount} > ${STREAM_BUDGET}) — disabling motion blur to avoid ffmpeg fd exhaustion`
    );
  }

  const lyricPngs = [];
  if (chunks.length) {
    const mainCount = chunks.filter((c) => c.kind === "main").length;
    const adlibCount = chunks.length - mainCount;
    const animCount = allowMotionBlur ? projectedAnimCount : 0;
    console.log(
      `[video] pre-rendering lyrics: ${mainCount} main + ${adlibCount} adlib (+${animCount} blur twins)`
    );
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const pngPath = path.join(TMP_DIR, `${outputName}-lyric-${i}.png`);
      const { sharpPath, blurPath } = await renderLyricPair(c.text, pngPath, {
        adlib: c.kind === "adlib",
        color: colorName,
        glow: glowEnabled,
        motionBlur: c.animate && allowMotionBlur,
      });
      lyricPngs.push({ sharpPath, blurPath });
    }
  }

  // 4. Build ffmpeg inputs
  const inputs = [];
  let inputIdx = 0;

  // Sample-accurate audio trimming:
  //   1) Fast input seek to (startOffset - 0.5s) to avoid decoding from t=0
  //   2) atrim filter for exact sample-level cut aligned to startOffset
  // Combined: fast AND frame-accurate.
  const preSeek = Math.max(0, startOffset - 0.5);
  const atrimStart = startOffset - preSeek; // 0.5s if preSeek > 0, else startOffset
  inputs.push(
    "-ss", preSeek.toFixed(3),
    "-t", (clipDuration + 1).toFixed(3),
    "-i", audioPath
  );
  const audioIdx = inputIdx++;

  // Each image input spawns a decoder; forcing -threads 1 per input prevents
  // thread explosion when we have many PNG inputs.
  let vinylIdx = -1;
  if (vinylPath) {
    inputs.push("-threads", "1", "-loop", "1", "-i", vinylPath);
    vinylIdx = inputIdx++;
  }

  const noteIndices = [];
  for (const np of notePaths) {
    inputs.push("-threads", "1", "-loop", "1", "-i", np);
    noteIndices.push(inputIdx++);
  }

  const lyricMeta = [];
  for (const { sharpPath, blurPath } of lyricPngs) {
    inputs.push("-threads", "1", "-loop", "1", "-i", sharpPath);
    const sharpIdx = inputIdx++;
    let blurIdx = -1;
    if (blurPath) {
      inputs.push("-threads", "1", "-loop", "1", "-i", blurPath);
      blurIdx = inputIdx++;
    }
    lyricMeta.push({ sharpIdx, blurIdx });
  }

  // 5. Build filter graph
  const filterParts = [];

  filterParts.push(
    `color=c=0x0a0a0a:s=${WIDTH}x${HEIGHT}:r=25,format=yuva420p[bg]`
  );
  let lastLabel = "bg";

  // Rotating vinyl
  if (vinylIdx !== -1) {
    filterParts.push(
      `[${vinylIdx}:v]format=rgba,rotate='2*PI*t/8':c=none:ow=${VINYL_SIZE}:oh=${VINYL_SIZE}[vinyl]`
    );
    filterParts.push(
      `[${lastLabel}][vinyl]overlay=x=${VINYL_X}:y=${VINYL_Y}:shortest=0[vv]`
    );
    lastLabel = "vv";
  }

  // Orbiting notes around the vinyl
  noteIndices.forEach((idx, i) => {
    const phase = (i * 2 * Math.PI) / noteIndices.length;
    const cycle = NOTE_CYCLE_SECONDS + i * 2;
    const prep = `n${i}`;
    const out = `nv${i}`;
    filterParts.push(`[${idx}:v]format=rgba[${prep}]`);
    // x = centerX - NOTE_SIZE/2 + R*cos(2PI*t/cycle + phase)
    // y = centerY - NOTE_SIZE/2 + R*sin(2PI*t/cycle + phase)
    const cx = VINYL_CENTER_X - NOTE_SIZE / 2;
    const cy = VINYL_CENTER_Y - NOTE_SIZE / 2;
    const xExpr = `${cx}+${NOTE_ORBIT_RADIUS}*cos(2*PI*t/${cycle}+${phase.toFixed(4)})`;
    const yExpr = `${cy}+${NOTE_ORBIT_RADIUS}*sin(2*PI*t/${cycle}+${phase.toFixed(4)})`;
    filterParts.push(
      `[${lastLabel}][${prep}]overlay=x='${xExpr}':y='${yExpr}'[${out}]`
    );
    lastLabel = out;
  });

  // Lyrics overlays. For each animated chunk with motion blur:
  //   - blurred twin fades in quickly then fades out during the first ~0.10s
  //   - sharp version fades in slightly delayed, stays until chunk end
  // Non-animated chunks (mid-line cumulative) swap instantly.
  const fd = anim.fadeIn.toFixed(3);
  const offsetPx = anim.offsetPx;

  lyricMeta.forEach((meta, i) => {
    const seg = chunks[i];
    const baseY = seg.kind === "adlib" ? ADLIB_ZONE_Y : LYRIC_ZONE_Y;
    const s = seg.start.toFixed(3);
    const e = seg.end.toFixed(3);

    if (seg.animate) {
      const yExpr =
        offsetPx > 0
          ? `${baseY}+${offsetPx}*max(0,1-(t-${s})/${fd})`
          : `${baseY}`;

      // Blur twin (if present): fade in 0→1 quickly (0.04s), fade out at +0.10s over 0.08s
      if (meta.blurIdx !== -1) {
        const blurPrep = `lb${i}`;
        const blurOut = `vb${i}`;
        const blurEnd = (seg.start + 0.22).toFixed(3);
        const blurFadeOutStart = (seg.start + 0.08).toFixed(3);
        filterParts.push(
          `[${meta.blurIdx}:v]format=rgba,fade=in:st=${s}:d=0.04:alpha=1,fade=out:st=${blurFadeOutStart}:d=0.10:alpha=1[${blurPrep}]`
        );
        filterParts.push(
          `[${lastLabel}][${blurPrep}]overlay=x=(W-w)/2:y='${yExpr}':enable='between(t,${s},${blurEnd})'[${blurOut}]`
        );
        lastLabel = blurOut;
      }

      // Sharp version: fade in slightly delayed so blur takes the lead briefly
      const sharpPrep = `l${i}`;
      const sharpOut = `v${i}`;
      const sharpFadeStart = (seg.start + 0.04).toFixed(3);
      filterParts.push(
        `[${meta.sharpIdx}:v]format=rgba,fade=in:st=${sharpFadeStart}:d=${fd}:alpha=1[${sharpPrep}]`
      );
      filterParts.push(
        `[${lastLabel}][${sharpPrep}]overlay=x=(W-w)/2:y='${yExpr}':enable='between(t,${s},${e})'[${sharpOut}]`
      );
      lastLabel = sharpOut;
    } else {
      const prep = `l${i}`;
      const out = `v${i}`;
      filterParts.push(`[${meta.sharpIdx}:v]format=rgba[${prep}]`);
      filterParts.push(
        `[${lastLabel}][${prep}]overlay=x=(W-w)/2:y=${baseY}:enable='between(t,${s},${e})'[${out}]`
      );
      lastLabel = out;
    }
  });

  filterParts.push(`[${lastLabel}]format=yuv420p[vout]`);

  // Sample-accurate audio trim: atrim + asetpts resets PTS to 0
  filterParts.push(
    `[${audioIdx}:a]atrim=start=${atrimStart.toFixed(3)}:duration=${clipDuration.toFixed(
      3
    )},asetpts=PTS-STARTPTS[aout]`
  );

  const filterComplex = filterParts.join(";");

  const args = [
    "-y",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-t", clipDuration.toFixed(3),
    outputPath,
  ];

  console.log(
    `[video] encoding: vinyl=${!!vinylPath} notes=${noteIndices.length} lyric_chunks=${lyricMeta.length}`
  );
  await runFfmpegRaw(args);
  console.log(`[video] done → ${outputPath}`);

  // Cleanup ephemeral render assets. Audio & cover are NOT deleted here
  // because the pipeline controls their lifecycle (for regeneration).
  if (vinylPath) { try { await fs.unlink(vinylPath); } catch {} }
  for (const p of notePaths) { try { await fs.unlink(p); } catch {} }
  for (const { sharpPath, blurPath } of lyricPngs) {
    try { await fs.unlink(sharpPath); } catch {}
    if (blurPath) { try { await fs.unlink(blurPath); } catch {} }
  }

  return outputPath;
}
