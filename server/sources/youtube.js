// server/sources/youtube.js
// Ingests the channel's "How to...?" tutorial PLAYLISTS into the Knowledge
// Base (NOT the general uploads, which are marketing shorts). Each video
// becomes a KB article tagged source:"youtube" with its watch URL, so the AI
// can attach a relevant repair/installation tutorial link when it helps.
//
// Needs the YouTube Data API v3: a Google Cloud API key (AIza...) with that
// API enabled — the Gemini/AI Studio key does NOT work here.
//
// By default it discovers playlists on the channel whose title matches
// YOUTUBE_PLAYLIST_FILTER (default "how to"). Override with an explicit
// comma-separated YOUTUBE_PLAYLIST_IDS to pin exact playlists.

const {
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  YOUTUBE_HANDLE,
  YOUTUBE_PLAYLIST_IDS,
  YOUTUBE_PLAYLIST_FILTER,
} = process.env;
const MAX = Number(process.env.YOUTUBE_MAX_VIDEOS || 200);
const FILTER = new RegExp(YOUTUBE_PLAYLIST_FILTER || "how\\s*to", "i");
const API = "https://www.googleapis.com/youtube/v3";

const explicitPlaylists = (YOUTUBE_PLAYLIST_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function youtubeConfigured() {
  return Boolean(
    YOUTUBE_API_KEY &&
      (explicitPlaylists.length || YOUTUBE_CHANNEL_ID || YOUTUBE_HANDLE)
  );
}

async function yt(path, params) {
  const qs = new URLSearchParams({ ...params, key: YOUTUBE_API_KEY });
  const res = await fetch(`${API}/${path}?${qs.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `YouTube API ${res.status}: ${data?.error?.message || "unknown"}`
    );
  }
  return data;
}

async function resolveChannelId() {
  if (YOUTUBE_CHANNEL_ID) return YOUTUBE_CHANNEL_ID;
  const handle = (YOUTUBE_HANDLE || "").replace(/^@/, "");
  if (!handle) throw new Error("no channel id or handle configured");
  const r = await yt("channels", { part: "id", forHandle: handle });
  const id = r.items?.[0]?.id;
  if (!id) throw new Error(`channel not found for handle @${handle}`);
  return id;
}

// All playlists on the channel → [{ id, title }]
async function listChannelPlaylists(channelId) {
  const out = [];
  let pageToken;
  do {
    const data = await yt("playlists", {
      part: "snippet,contentDetails",
      channelId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const p of data.items || []) {
      out.push({ id: p.id, title: p.snippet?.title || "" });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// Titles for explicitly-pinned playlist IDs.
async function titlesFor(ids) {
  const data = await yt("playlists", { part: "snippet", id: ids.join(",") });
  return (data.items || []).map((p) => ({
    id: p.id,
    title: p.snippet?.title || "",
  }));
}

// Decide which playlists to ingest.
async function targetPlaylists() {
  if (explicitPlaylists.length) return titlesFor(explicitPlaylists);
  const channelId = await resolveChannelId();
  const all = await listChannelPlaylists(channelId);
  return all.filter((p) => FILTER.test(p.title));
}

async function playlistVideos(playlistId, remaining) {
  const videos = [];
  let pageToken;
  while (videos.length < remaining) {
    const data = await yt("playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: String(Math.min(50, remaining - videos.length)),
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of data.items || []) {
      const s = item.snippet || {};
      const videoId = s.resourceId?.videoId;
      if (videoId) videos.push({ videoId, title: s.title, description: s.description });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return videos;
}

function slug(str) {
  return String(str).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
}

// Ingest the selected playlists' videos. Returns { articles, errors } — the
// caller persists via kb.replaceSource("youtube", articles).
export async function ingestYouTube() {
  if (!youtubeConfigured()) {
    return {
      articles: [],
      errors: [{ error: "YouTube not configured (set YOUTUBE_API_KEY + channel)" }],
    };
  }

  const stamp = new Date().toISOString();
  const articles = [];
  const errors = [];
  const seen = new Set();

  let playlists;
  try {
    playlists = await targetPlaylists();
  } catch (err) {
    return { articles: [], errors: [{ error: err.message }] };
  }
  if (!playlists.length) {
    return {
      articles: [],
      errors: [
        { error: `no playlists matched filter /${FILTER.source}/i on the channel` },
      ],
    };
  }

  for (const pl of playlists) {
    try {
      const vids = await playlistVideos(pl.id, MAX - articles.length);
      for (const v of vids) {
        if (seen.has(v.videoId)) continue; // a video can sit in several playlists
        seen.add(v.videoId);
        const desc = (v.description || "").trim();
        articles.push({
          id: `YT-${v.videoId}`,
          title: v.title || "Untitled video",
          body: `How-to video tutorial (playlist: ${pl.title}): ${v.title || ""}\n${desc}`.trim(),
          finish: null,
          tags: ["video", "youtube", "how-to", slug(pl.title)],
          sourceUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
          updatedAt: stamp,
        });
        if (articles.length >= MAX) break;
      }
    } catch (err) {
      errors.push({ playlist: pl.title, error: err.message });
    }
    if (articles.length >= MAX) break;
  }

  return { articles, errors };
}
