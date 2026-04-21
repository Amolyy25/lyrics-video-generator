import fetch from "node-fetch";

const UA = "lyric-video-gen/1.0 (local dev)";

function parseLRC(lrcString) {
  const lineRegex = /\[(\d{2}):(\d{2}(?:\.\d+)?)\]\s*(.*)/;
  const metaRegex = /^\[[a-z]{2,}:.*\]$/i;
  const lines = [];

  for (const raw of lrcString.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (metaRegex.test(line)) continue;

    const m = line.match(lineRegex);
    if (!m) continue;

    const minutes = parseInt(m[1], 10);
    const seconds = parseFloat(m[2]);
    const text = m[3].trim();
    if (!text) continue;

    lines.push({ time: minutes * 60 + seconds, text });
  }

  return lines.sort((a, b) => a.time - b.time);
}

function parsePlain(plainString) {
  return plainString
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ time: null, text }));
}

function pickBest(results) {
  const synced = results.filter((r) => r.syncedLyrics);
  if (synced.length) {
    return synced.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  }
  return results.find((r) => r.plainLyrics) || null;
}

function cleanYoutubeTitle(ytTitle) {
  if (!ytTitle) return { artist: null, title: null };
  let t = ytTitle
    .replace(/\(.*?\)/g, " ")
    .replace(/\[.*?\]/g, " ")
    .replace(/\b(official\s*(music\s*)?(video|audio|lyric\s*video|visualizer)|HD|4K|lyrics?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const dash = t.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
  return { artist: null, title: t };
}

async function lrclibSearch(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://lrclib.net/api/search?${qs}`;
  console.log(`[lyrics] GET ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.warn(`[lyrics] lrclib ${res.status} ${res.statusText}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchLyrics(artist, title, youtubeTitle = null) {
  const attempts = [];

  attempts.push({ artist_name: artist, track_name: title });
  attempts.push({ q: `${artist} ${title}` });
  attempts.push({ q: title });

  if (youtubeTitle) {
    const clean = cleanYoutubeTitle(youtubeTitle);
    if (clean.artist && clean.title) {
      attempts.push({ artist_name: clean.artist, track_name: clean.title });
      attempts.push({ q: `${clean.artist} ${clean.title}` });
    } else if (clean.title) {
      attempts.push({ q: clean.title });
    }
  }

  for (const params of attempts) {
    const results = await lrclibSearch(params);
    console.log(`[lyrics] attempt ${JSON.stringify(params)} → ${results.length} result(s)`);
    if (!results.length) continue;

    const best = pickBest(results);
    if (!best) continue;

    console.log(
      `[lyrics] picked: "${best.trackName}" by "${best.artistName}" (synced=${!!best.syncedLyrics})`
    );

    if (best.syncedLyrics) {
      return {
        lines: parseLRC(best.syncedLyrics),
        hasSyncedLyrics: true,
        expectedDuration: best.duration || null,
        matchedTrack: best.trackName,
        matchedArtist: best.artistName,
      };
    }
    if (best.plainLyrics) {
      return {
        lines: parsePlain(best.plainLyrics),
        hasSyncedLyrics: false,
        expectedDuration: best.duration || null,
        matchedTrack: best.trackName,
        matchedArtist: best.artistName,
      };
    }
  }

  console.warn(`[lyrics] no lyrics found after ${attempts.length} attempts`);
  return {
    lines: [],
    hasSyncedLyrics: false,
    expectedDuration: null,
    matchedTrack: null,
    matchedArtist: null,
  };
}
