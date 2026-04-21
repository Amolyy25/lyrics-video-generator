import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "..", "outputs");
const TMP_DIR = path.resolve(__dirname, "..", "tmp");

// yt-dlp exit codes we tolerate as success
// 101 = DownloadCancelled (--max-downloads reached) -> the download DID succeed
const TOLERATED_EXIT_CODES = new Set([0, 101]);

async function ensureDirs() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
}

function logBox(title, body) {
  const width = 70;
  const bar = "─".repeat(width);
  console.log(`\n┌─ ${title} ${bar.slice(title.length + 3)}┐`);
  for (const line of body.split("\n")) {
    for (let i = 0; i < line.length; i += width) {
      console.log(`│ ${line.slice(i, i + width).padEnd(width)} │`);
    }
  }
  console.log(`└${"─".repeat(width + 2)}┘\n`);
}

function runYtDlp(label, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    console.log(`[yt-dlp:${label}] spawning: yt-dlp ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`yt-dlp ${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "yt-dlp not found on PATH. Install it with: `brew install yt-dlp` (macOS) or `pip install yt-dlp` (Linux)"
          )
        );
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const stdoutTrim = stdout.trim();
      const stderrTrim = stderr.trim();

      if (TOLERATED_EXIT_CODES.has(code)) {
        if (code === 101) {
          console.log(`[yt-dlp:${label}] exit 101 (max-downloads reached, treated as success)`);
        } else {
          console.log(`[yt-dlp:${label}] exit 0 OK`);
        }
        if (stderrTrim) console.log(`[yt-dlp:${label}] stderr snippet:\n${stderrTrim.slice(-500)}`);
        resolve({ stdout, stderr, code });
      } else {
        logBox(
          `YT-DLP FAILED (code ${code}) — step: ${label}`,
          [
            `command: yt-dlp ${args.join(" ")}`,
            "",
            "─── stdout ───",
            stdoutTrim || "(empty)",
            "",
            "─── stderr ───",
            stderrTrim || "(empty)",
          ].join("\n")
        );
        const shortErr = stderrTrim.split("\n").slice(-5).join(" | ") || "(no stderr)";
        reject(
          new Error(
            `yt-dlp [${label}] exited with code ${code}. Last stderr: ${shortErr}`
          )
        );
      }
    });
  });
}

async function searchCandidates(query, matchFilter) {
  const args = [
    "--no-playlist",
    "--print", "%(id)s\t%(title)s\t%(thumbnail)s\t%(duration)s\t%(channel)s",
    "--skip-download",
    ...(matchFilter ? ["--match-filter", matchFilter] : []),
    query,
  ];
  const { stdout } = await runYtDlp("meta", args);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, title, thumb, duration, channel] = line.split("\t");
      return {
        id,
        title,
        thumb,
        duration: parseFloat(duration) || 0,
        channel,
      };
    });
}

function pickBestCandidate(candidates, expected) {
  // Score: lower is better.
  //   base = |deltaDuration|
  //   - 8 if Topic channel (album/canonical audio, matches lrclib timing exactly)
  //   - 3 if VEVO/official (music video, often matches album but may have intro)
  //   + 1 for each indicator of non-standard upload (sped up, nightcore, cover, live, remix)
  const scored = candidates
    .filter((c) => c.id && c.duration > 0)
    .map((c) => {
      const channel = (c.channel || "").toLowerCase();
      const title = (c.title || "").toLowerCase();
      let score = Math.abs(c.duration - expected);
      if (/\s-\s*topic$/.test(channel)) score -= 8;
      else if (/vevo|official/.test(channel)) score -= 3;
      if (/sped\s*up|slowed|nightcore|cover|live|remix|mashup|version/.test(title)) score += 5;
      return { ...c, delta: Math.abs(c.duration - expected), score };
    })
    .sort((a, b) => a.score - b.score);
  return scored[0] || null;
}

// Strip common store/platform suffixes that pollute YouTube search
// e.g. "KYKY2BONDY - Single" → "KYKY2BONDY", "Song Name - Remastered 2011" → "Song Name"
function cleanTrackTitle(title) {
  return title
    .replace(/\s*[-–—]\s*(Single|EP|Album|Deluxe|Remastered(?:\s+\d{4})?|Bonus\s*Track|Album\s*Version|Radio\s*Edit|Explicit|Clean)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function downloadFromYoutube(
  artist,
  title,
  outputBase,
  { expectedDuration = null, durationTolerance = 10 } = {}
) {
  await ensureDirs();

  const cleanedTitle = cleanTrackTitle(title);
  if (cleanedTitle !== title) {
    console.log(`[download] cleaned title: "${title}" → "${cleanedTitle}"`);
  }

  const outTemplate = path.join(TMP_DIR, `${outputBase}.%(ext)s`);
  const hasExpected = expectedDuration && expectedDuration > 0;

  console.log(
    `[download] start. expected=${
      hasExpected ? `${expectedDuration.toFixed(1)}s ±${durationTolerance}s` : "n/a"
    } outputBase=${outputBase}`
  );

  let picked = null;

  if (hasExpected) {
    // 1. Search 15 candidates unfiltered, then pick the closest by duration.
    //    This is more robust than --match-filter (which can drop decimals).
    const query = `ytsearch15:${artist} ${cleanedTitle}`;
    console.log(`[download] query="${query}" (score = |Δduration| - topic/vevo bonus)`);
    const candidates = await searchCandidates(query, null);

    picked = pickBestCandidate(candidates, expectedDuration);

    const scored = candidates
      .filter((c) => c.id && c.duration > 0)
      .map((c) => {
        const channel = (c.channel || "").toLowerCase();
        let score = Math.abs(c.duration - expectedDuration);
        if (/\s-\s*topic$/.test(channel)) score -= 8;
        else if (/vevo|official/.test(channel)) score -= 3;
        return { ...c, score };
      })
      .sort((a, b) => a.score - b.score);

    console.log(
      `[download] ${candidates.length} candidates (sorted by score):\n` +
        scored
          .slice(0, 10)
          .map(
            (c, i) =>
              `  ${i + 1}. score=${c.score.toFixed(1).padStart(6)}  ${c.duration
                .toFixed(0)
                .padStart(3)}s  ${c.channel || "?"} — ${c.title}`
          )
          .join("\n")
    );

    if (picked && picked.delta > durationTolerance) {
      console.warn(
        `[download] closest is ${picked.duration.toFixed(0)}s (Δ${picked.delta.toFixed(
          1
        )}s > tolerance ${durationTolerance}s) — lrclib sync may be imperfect`
      );
    }
  }

  if (!picked) {
    // Fallback: plain "official audio" search, single result
    const fbQuery = `ytsearch1:${artist} ${cleanedTitle} official audio`;
    console.log(`[download] fallback query="${fbQuery}"`);
    const candidates = await searchCandidates(fbQuery, null);
    picked = candidates[0] || null;
  }

  if (!picked || !picked.id) {
    throw new Error("No YouTube result found for this search");
  }

  console.log(
    `[download] picked: id=${picked.id} channel="${picked.channel}" duration=${picked.duration.toFixed(
      0
    )}s title="${picked.title}"`
  );

  const ytId = picked.id;
  const youtubeTitle = picked.title;
  const coverUrl = picked.thumb;
  const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;

  const dlArgs = [
    "--no-playlist",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--output", outTemplate,
    videoUrl,
  ];

  await runYtDlp("download", dlArgs);

  const audioPath = path.join(TMP_DIR, `${outputBase}.mp3`);
  try {
    const stat = await fs.stat(audioPath);
    console.log(`[download] audio ready: ${audioPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch {
    throw new Error(
      `yt-dlp finished but no mp3 produced at ${audioPath}. Check tmp/ dir or ffmpeg post-processor.`
    );
  }

  return {
    audioPath,
    coverUrl: coverUrl || "",
    youtubeTitle: youtubeTitle || `${artist} - ${title}`,
  };
}

export { OUTPUT_DIR, TMP_DIR };
