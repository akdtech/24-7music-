"use strict";

/*
 * DEATH Music — CLEAN YOUTUBE ENGINE
 *
 * One source path:
 *   query -> YouTube search -> exact YouTube video -> yt-dlp resolves that
 *   video -> FFmpeg PCM -> Discord voice player.
 *
 * No Audius, SoundCloud, Piped, Invidious or random catalog substitution.
 * UI/control patches remain independent.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { PassThrough } = require("node:stream");
const {
  createAudioResource,
  StreamType
} = require("@discordjs/voice");
const MusicManager = require("./DirectMusicManager");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const COOKIE_FILE = process.env.YOUTUBE_COOKIES_PATH || "/tmp/youtube-cookies.txt";

try {
  if (process.env.YOUTUBE_COOKIES_B64) {
    fs.writeFileSync(
      COOKIE_FILE,
      Buffer.from(process.env.YOUTUBE_COOKIES_B64, "base64"),
      { mode: 0o600 }
    );
  }
} catch {}

const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const kill = child => { try { child?.kill("SIGKILL"); } catch {} };

function cookieArgs() {
  try {
    return fs.existsSync(COOKIE_FILE) ? ["--cookies", COOKIE_FILE] : [];
  } catch {
    return [];
  }
}

function youtubeId(value) {
  return String(value || "").match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i
  )?.[1] || null;
}

function youtubeUrl(id) {
  return "https://www.youtube.com/watch?v=" + id;
}

function normalize(info, requester) {
  const id = info?.id || info?.identifier || youtubeId(info?.webpage_url);
  const url = info?.webpage_url || info?.original_url || (id ? youtubeUrl(id) : null);
  return {
    identifier: id || url,
    id: id || url,
    url,
    title: clean(info?.title) || "Unknown track",
    author: clean(info?.uploader || info?.channel || info?.artist) || "Unknown artist",
    length: Number(info?.duration || 0) * 1000,
    requester: requester || null,
    thumbnail: info?.thumbnail || (id ? "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" : null),
    source: "youtube",
    isAutoplay: false
  };
}

function ytArgs(profile) {
  const args = [
    "--no-warnings",
    "--no-progress",
    "--no-playlist",
    "--force-ipv4",
    ...cookieArgs(),
    "--extractor-args",
    "youtube:player_client=" + profile + ";fetch_pot=always;use_ad_playback_context=false",
    "--extractor-args",
    "youtubepot-wpc:browser_path=/usr/bin/chromium",
    "--remote-components",
    "ejs:github",
    "--js-runtimes",
    "node,deno"
  ];

  const pot = clean(process.env.YTDLP_POT_PROVIDER_URL);
  if (pot) {
    args.splice(
      8,
      0,
      "--extractor-args",
      "youtubepot-bgutilhttp:base_url=" + pot
    );
  }

  return args;
}

function runYtDlp(args, timeoutMs, profile = "web_music,web_embedded") {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [...ytArgs(profile), ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      kill(child);
      finish(reject, new Error("yt-dlp timed out."));
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > 150000) stdout = stdout.slice(-150000);
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    child.on("error", error => finish(reject, error));
    child.on("close", code => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(
        reject,
        new Error(clean(stderr).slice(-2200) || "yt-dlp exited " + code)
      );
    });
  });
}

async function youtubeSearch(query, requester) {
  const q = clean(query);
  if (!q) throw new Error("Please provide a song name.");

  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(q)) {
    const id = youtubeId(q);
    if (!id) throw new Error("That YouTube URL is not a valid video URL.");
    try {
      const result = await runYtDlp(
        [youtubeUrl(id), "--dump-single-json", "--skip-download"],
        12000,
        "web_music,web_embedded"
      );
      return normalize(JSON.parse(result.stdout), requester);
    } catch {
      return normalize({ id, webpage_url: youtubeUrl(id), title: "YouTube video" }, requester);
    }
  }

  const result = await runYtDlp(
    [
      "ytsearch8:" + q,
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      "8"
    ],
    15000,
    "web_music,web_embedded"
  );

  const data = JSON.parse(result.stdout || "{}");
  const entries = Array.isArray(data?.entries) ? data.entries : [];

  const norm = value => clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const queryNorm = norm(q);
  const words = queryNorm.split(" ").filter(Boolean);
  const bad = /\b(playlist|mix|compilation|meg[a -]?mix|full album|album mix|nonstop|continuous|1 hour|2 hour|3 hour|karaoke|instrumental)\b/i;

  const candidates = entries
    .filter(entry => entry?.id && entry?.title && !bad.test(entry.title))
    .map(entry => {
      const title = norm(entry.title);
      const channel = norm(entry.channel || entry.uploader);
      const titleWords = new Set(title.split(" ").filter(Boolean));
      const channelWords = new Set(channel.split(" ").filter(Boolean));
      const titleMatches = words.filter(w => titleWords.has(w)).length;
      const channelMatches = words.filter(w => channelWords.has(w)).length;

      let score = titleMatches * 20 + channelMatches * 5;
      if (title === queryNorm) score += 250;
      if (title.includes(queryNorm)) score += 140;
      if (words.length && words.every(w => titleWords.has(w))) score += 90;

      return { entry, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) throw new Error('No YouTube result found for "' + q + '".');

  const id = youtubeId(best.entry.url) || best.entry.id;
  const track = {
    identifier: id,
    id,
    url: youtubeUrl(id),
    title: clean(best.entry.title),
    author: clean(best.entry.channel || best.entry.uploader) || "YouTube",
    length: Number(best.entry.duration || 0) * 1000,
    requester: requester || null,
    thumbnail: best.entry.thumbnail || "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
    source: "youtube",
    isAutoplay: false
  };

  console.log('🎯 YouTube search: "' + q + '" -> "' + track.title + '" by "' + track.author + '"');
  return track;
}

async function resolveYouTube(track) {
  const id = youtubeId(track?.url) || track?.id || track?.identifier;
  if (!id) throw new Error("No YouTube video ID.");

  const url = youtubeUrl(id);
  const profiles = [
    "web_music,web_embedded",
    "web_creator,web_embedded",
    "web_safari",
    "mweb",
    "android_vr"
  ];

  let lastError = null;

  for (const profile of profiles) {
    try {
      const result = await runYtDlp(
        [
          url,
          "--dump-single-json",
          "--skip-download",
          "--format",
          "bestaudio/best"
        ],
        10000,
        profile
      );

      const info = JSON.parse(result.stdout || "{}");
      const mediaUrl = clean(
        info?.url ||
        info?.requested_formats?.find(item => item?.url)?.url
      );

      if (!mediaUrl) throw new Error("YouTube returned no audio stream.");

      const headers = Object.entries(info?.http_headers || {})
        .filter(([key, value]) => key && value)
        .map(([key, value]) => key + ": " + value)
        .join("\r\n");

      console.log("🔑 YouTube stream resolved with " + profile);
      return { url: mediaUrl, headers };
    } catch (error) {
      lastError = error;
      console.warn(
        "⚠️ YouTube resolve " + profile + " failed: " +
        clean(error?.message || error).slice(-500)
      );
    }
  }

  throw lastError || new Error("YouTube audio stream could not be resolved.");
}

async function startYouTube(manager, guildId, track, startMs, token, handoff) {
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  const resolved = await resolveYouTube(track);

  if (state.playbackToken !== token) {
    throw new Error("Playback attempt superseded.");
  }

  const inputOptions = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5"
  ];

  if (resolved.headers) {
    inputOptions.push("-headers", resolved.headers + "\r\n");
  }

  const ff = spawn(FFMPEG, [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    ...inputOptions,
    "-i", resolved.url,
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn",
    "-af", "aresample=48000:async=1:first_pts=0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  ff.stderr.on("data", chunk => {
    stderr += chunk.toString();
    if (stderr.length > 5000) stderr = stderr.slice(-5000);
  });

  const first = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kill(ff);
      reject(new Error(
        "YouTube produced no audio within 12 seconds. " +
        clean(stderr).slice(-700)
      ));
    }, 12000);

    let done = false;
    const fail = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    ff.stdout.once("data", chunk => {
      if (!chunk?.length) return fail(new Error("YouTube returned empty audio."));
      done = true;
      clearTimeout(timer);
      resolve(chunk);
    });

    ff.once("error", fail);
    ff.once("close", code => {
      if (!done && code !== 0) {
        fail(new Error("FFmpeg exited " + code + ": " + clean(stderr).slice(-700)));
      }
    });
  }).catch(error => {
    kill(ff);
    throw error;
  });

  if (state.playbackToken !== token) {
    kill(ff);
    throw new Error("Playback attempt superseded.");
  }

  const oldStream = manager.streams.get(guildId);
  const pcm = new PassThrough({ highWaterMark: 1024 * 1024 });
  const resolvedTrack = {
    ...track,
    url: youtubeUrl(track?.id || youtubeId(track?.url) || track?.identifier),
    source: "youtube",
    title: track.title || "YouTube",
    author: track.author || "YouTube"
  };

  const resource = createAudioResource(pcm, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: resolvedTrack
  });

  resource.volume?.setVolume(
    Math.max(0.01, Number(state.volume || 70) / 100)
  );

  state.current = resolvedTrack;
  state.pendingTrack = null;
  state.audioResource = resource;
  state.transitioning = false;
  state.paused = false;
  state.startedAt = Date.now();
  state.positionOffset = Math.max(0, Number(startMs || 0));

  manager.streams.set(guildId, {
    ff,
    pcm,
    resource,
    source: "youtube"
  });

  pcm.write(first);
  ff.stdout.pipe(pcm);
  player.play(resource);

  if (handoff && oldStream && oldStream !== manager.streams.get(guildId)) {
    try { oldStream.ff?.kill?.("SIGKILL"); } catch {}
    try { oldStream.yt?.kill?.("SIGKILL"); } catch {}
    try { oldStream.pcm?.destroy?.(); } catch {}
  }

  Promise.resolve(manager.updateVoiceStatus?.(
    guildId,
    "🎵 " + manager.getTrackTitle(resolvedTrack)
  )).catch(() => {});

  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});

  console.log("🎧 YouTube playback started: " + manager.getTrackTitle(resolvedTrack));
  return true;
}

if (!MusicManager.prototype.__deathCleanYouTubeEngine) {
  MusicManager.prototype.__deathCleanYouTubeEngine = true;

  const originalSearch = MusicManager.prototype.search;
  const originalStartTrack = MusicManager.prototype.startTrack;

  MusicManager.prototype.search = async function cleanYouTubeSearch(query, requester) {
    return {
      type: "track",
      tracks: [await youtubeSearch(query, requester)]
    };
  };

  MusicManager.prototype.startTrack = async function cleanYouTubeStartTrack(
    guildId,
    track,
    startMs = 0,
    options = {}
  ) {
    const state = this.getState(guildId);
    state.playbackToken = Number(state.playbackToken || 0) + 1;
    const token = state.playbackToken;
    const previous = state.current;

    state.pendingTrack = track;
    state.transitioning = true;

    try {
      return await startYouTube(
        this,
        guildId,
        track,
        startMs,
        token,
        options?.handoff !== false
      );
    } catch (error) {
      if (state.playbackToken !== token) throw error;
      state.current = previous || null;
      state.pendingTrack = null;
      state.transitioning = false;
      throw error;
    }
  };

  console.log("▶️ DEATH CLEAN YOUTUBE ENGINE loaded: YouTube search + one playback path.");
}

module.exports = { youtubeSearch, resolveYouTube };
