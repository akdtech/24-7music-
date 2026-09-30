"use strict";

/* DEATH Music — strict one-at-a-time related autoplay. */
const { spawn } = require("node:child_process");
const MusicManager = require("./DirectMusicManager");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const MAX_TRACK_MS = 8 * 60 * 1000;
const MIN_TRACK_MS = 45 * 1000;
const RECENT_LIMIT = 60;

const BAD_TITLE = /\b(playlist|mix|compilation|full album|album mix|nonstop|continuous|radio|medley|hour mix|mega[\s-]?mix|collection|reaction|review|podcast|karaoke|cover|remix|rework|bootleg|mashup|nightcore|slowed|sped up|speed up|slowed\s*\+\s*reverb|8d audio|8d|bass boosted|ultra slowed|super slowed|live version|concert|acoustic version|instrumental version|alternate version|alternative version|extended version|long version|radio edit|club edit|fan edit|fanmade|fan made)\b/i;

const BAD_ARTIST = /\b(remix|remixes|cover|covers|nightcore|slowed|sped up|mashup|bootleg|fanmade|fan made|karaoke|instrumental|reaction|podcast|unofficial|non official|music hub|best music)\b/i;

const ALT_WORDS = new Set([
  "remix","remastered","remaster","edit","rework","bootleg","mashup","cover",
  "live","acoustic","instrumental","karaoke","nightcore","slowed","sped",
  "speed","reverb","8d","extended","version","radio","club","mix","demo",
  "alternate","alternative"
]);

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const norm = v => clean(v).toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ")
  .replace(/\s+/g, " ").trim();

const idOf = t => String(t?.identifier || t?.id || t?.url || "").trim();
const artistOf = t => clean(t?.author || t?.uploader || t?.channel);
const titleOf = t => clean(t?.title);

function sameArtist(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function canonicalTitle(value) {
  return norm(value)
    .replace(/\b(official|audio|video|lyrics?|hd|hq|4k|mv|visualizer)\b/g, " ")
    .replace(/\b(feat|ft|featuring)\b.*$/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\b(remix|remastered|rework|edit|version|live|acoustic|instrumental|karaoke|nightcore|slowed|sped|speed|reverb|8d|extended|radio|club|mix)\b.*$/g, " ")
    .replace(/\s+/g, " ").trim();
}

function songIdentity(track) {
  return canonicalTitle(titleOf(track)) + " | " + norm(artistOf(track));
}

function titleIdentity(track) {
  return canonicalTitle(titleOf(track));
}

function isAlternateVersion(track) {
  const title = norm(titleOf(track));
  const artist = norm(artistOf(track));

  if (!title) return true;
  if (BAD_TITLE.test(titleOf(track))) return true;
  if (BAD_ARTIST.test(artistOf(track))) return true;

  const tokens = new Set((title + " " + artist).split(" ").filter(Boolean));
  for (const word of ALT_WORDS) {
    if (tokens.has(word)) return true;
  }
  return false;
}

function officialSignal(track) {
  const text = norm(titleOf(track) + " " + artistOf(track));
  let score = 0;
  if (/\bofficial\b/.test(text)) score += 30;
  if (/\bvevo\b/.test(text)) score += 45;
  if (/\btopic\b/.test(text)) score += 45;
  if (/\bofficial audio\b/.test(text)) score += 25;
  if (/\bofficial music video\b/.test(text)) score += 20;
  return score;
}

function search(query) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [
      "--quiet", "--no-warnings", "--no-progress", "--no-playlist",
      "--flat-playlist", "--skip-download", "--playlist-end", "8",
      "--js-runtimes", "node",
      "--print", "%(id)s\\t%(title)s\\t%(channel)s\\t%(duration)s",
      "ytsearch8:" + clean(query)
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "", err = "", done = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      if (!done) {
        done = true;
        reject(new Error("autoplay search timeout"));
      }
    }, 10000);

    child.stdout.on("data", chunk => out += chunk.toString());
    child.stderr.on("data", chunk => err += chunk.toString());

    child.on("error", error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (code !== 0 && !out.trim()) {
        return reject(new Error(clean(err).slice(-1200) || "YouTube autoplay search failed"));
      }

      const entries = out.split(/\\r?\\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const parts = line.split("\\t");
          const id = clean(parts.shift());
          const duration = Number(parts.pop() || 0);
          const channel = clean(parts.pop() || "");
          const title = clean(parts.join("\\t"));
          return id && title ? { id, title, channel, duration } : null;
        })
        .filter(Boolean);

      resolve(entries);
    });
  });
}
function toTrack(entry, requester) {
  if (!entry?.id || !entry?.title) return null;
  return {
    identifier: entry.id,
    id: entry.id,
    url: "https://www.youtube.com/watch?v=" + entry.id,
    title: titleOf(entry),
    author: clean(entry.uploader || entry.channel || entry.creator) || "Unknown artist",
    genre: clean(entry.genre || entry.category || (Array.isArray(entry.categories) ? entry.categories.join(" ") : "") || (Array.isArray(entry.tags) ? entry.tags.join(" ") : "")),
    category: clean(Array.isArray(entry.categories) ? entry.categories.join(" ") : entry.category || ""),
    language: clean(entry.language || entry.defaultAudioLanguage || entry.default_audio_language || entry.defaultLanguage || ""),
    description: clean(entry.description || entry.shortDescription || ""),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    length: Number(entry.duration || 0) * 1000,
    requester: requester || null,
    thumbnail: entry.thumbnail || "https://i.ytimg.com/vi/" + entry.id + "/hqdefault.jpg",
    source: "youtube",
    isAutoplay: true
  };
}

function addHistory(state, track) {
  state.recent = [...(state.recent || []), idOf(track)].filter(Boolean).slice(-RECENT_LIMIT);
  state.recentSongs = [...(state.recentSongs || []), songIdentity(track)].filter(Boolean).slice(-RECENT_LIMIT);
  state.recentTitles = [...(state.recentTitles || []), titleIdentity(track)].filter(Boolean).slice(-RECENT_LIMIT);
}

async function findNext(manager, state) {
  const ctx = state.autoplayContext || {};
  const artist = clean(ctx.artist || ctx.author);
  const title = clean(ctx.title);
  const genre = clean(ctx.genre);
  const languageMap = new Map([
    ["sidhu moose wala","pa"],["sidhu moosewala","pa"],["karan aujla","pa"],["ap dhillon","pa"],
    ["shubh","pa"],["diljit dosanjh","pa"],["amrit maan","pa"],["prem dhillon","pa"],
    ["gurinder gill","pa"],["navaan sandhu","pa"],["arjan dhillon","pa"],["wazir patar","pa"],
    ["sunny malton","pa"],["sukha","pa"],["jordan sandhu","pa"],["parmish verma","pa"],
    ["jazzy b","pa"],["garry sandhu","pa"],["ammy virk","pa"],["raf saperra","pa"],
    ["sikander kahlon","pa"],["talwiinder","pa"],["dilpreet dhillon","pa"],["gurnam bhullar","pa"],
    ["karan randhawa","pa"],["hustinder","pa"],["cheema y","pa"],["jass manak","pa"],["guru randhawa","pa"],
    ["arijit singh","hi"],["badshah","hi"],["king","hi"],["jubin nautiyal","hi"],["shreya ghoshal","hi"],
    ["darshan raval","hi"],["vishal mishra","hi"],["anuv jain","hi"],["aditya rikhari","hi"],["raftaar","hi"],
    ["divine","hi"],["emiway bantai","hi"],["yo yo honey singh","hi"],["armaan malik","hi"],
    ["pritam","hi"],["sonu nigam","hi"],["atif aslam","ur"],["ali zafar","ur"]
  ]);
  const genreMap = new Map([
    ["sidhu moose wala","hiphop"],["sidhu moosewala","hiphop"],["karan aujla","hiphop"],
    ["ap dhillon","hiphop"],["shubh","hiphop"],["diljit dosanjh","desi"],["prem dhillon","hiphop"],
    ["arjan dhillon","hiphop"],["wazir patar","hiphop"],["sunny malton","hiphop"],["sukha","hiphop"]
  ]);
  const languageOf = track => {
    const artist = norm(artistOf(track));
    // Prefer a known artist-language mapping over YouTube's stream language.
    // YouTube can expose English as a translated/format fallback even when
    // the actual song is Punjabi/Hindi.
    for (const [name, code] of languageMap) {
      if (artist === name || artist.includes(name) || name.includes(artist)) return code;
    }
    const explicit = track?.language || track?.defaultAudioLanguage || track?.default_audio_language ||
      track?.defaultLanguage || track?.default_language;
    if (explicit) return String(explicit).toLowerCase().split(/[-_]/)[0];
    const text = clean([track?.title,track?.author,track?.uploader,track?.genre,track?.category,track?.description].filter(Boolean).join(" ")).toLowerCase();
    if (/[\u0a00-\u0a7f]/.test(text)) return "pa";
    if (/[\u0900-\u097f]/.test(text)) return "hi";
    if (/\b(punjabi|panjabi)\b/.test(text)) return "pa";
    if (/\b(hindi|bollywood)\b/.test(text)) return "hi";
    if (/\burdu\b/.test(text)) return "ur";
    if (/\barabic\b/.test(text)) return "ar";
    const a = norm(artistOf(track));
    for (const [name,code] of languageMap) if (a === name || a.includes(name) || name.includes(a)) return code;
    return "unknown";
  };
  const artistGenre = track => {
    const a = norm(artistOf(track));
    for (const [name,code] of genreMap) if (a === name || a.includes(name) || name.includes(a)) return code;
    return "";
  };
  const genreFamily = value => {
    const g = norm(value);
    if (/\b(gangsta|hardcore|trap|drill|hip hop|rap|grime)\b/.test(g)) return "hiphop";
    if (/\b(bhangra|punjabi|desi|indian pop|bollywood)\b/.test(g)) return "desi";
    if (/\b(pop|dance pop|synth pop|electropop)\b/.test(g)) return "pop";
    if (/\b(r&b|rnb|soul)\b/.test(g)) return "rnb";
    if (/\b(rock|alternative|indie rock|metal)\b/.test(g)) return "rock";
    if (/\b(edm|house|techno|trance|dubstep|electronic)\b/.test(g)) return "electronic";
    return g;
  };

  const language = ctx.languageLocked && ctx.language ? ctx.language : (ctx.language || languageOf(ctx));
  const targetGenre = ctx.genreLocked && ctx.genre ? genreFamily(ctx.genre) : (genreFamily(genre) || artistGenre(ctx));
  const langName = {pa:"Punjabi",hi:"Hindi",ur:"Urdu",ar:"Arabic",bn:"Bengali",ta:"Tamil",te:"Telugu",ml:"Malayalam",ja:"Japanese",ko:"Korean",es:"Spanish",fr:"French",de:"German",pt:"Portuguese",en:"English"}[language] || "";
  const genreName = {hiphop:"hip hop",desi:"desi Punjabi",pop:"pop",rnb:"R&B",rock:"rock",electronic:"electronic"}[targetGenre] || "";

  console.log("🧭 Autoplay context: " + (title || "Unknown") + " — " + (artist || "Unknown artist") +
    " | language=" + language + " | genre=" + (targetGenre || "unknown"));

  const seeds = [];
  if (title && artist) {
    seeds.push("songs like " + title + " by " + artist + " " + langName + " " + genreName + " similar artists official audio");
    seeds.push(artist + " similar artists " + langName + " " + genreName + " official audio");
  }
  if (langName && genreName) seeds.push(langName + " " + genreName + " similar songs official audio");
  if (langName) seeds.push(langName + " songs similar to " + (title || artist) + " official audio");
  if (!seeds.length) seeds.push("popular songs official audio");

  const recentIds = new Set((state.recent || []).map(String));
  const recentSongs = new Set((state.recentSongs || []).map(String));
  const recentTitles = new Set((state.recentTitles || []).map(String));
  if (ctx.id) recentIds.add(String(ctx.id));
  if (ctx.title) recentTitles.add(canonicalTitle(ctx.title));

  const candidates = [];
  const seen = new Set();

  // Search a small number of related seeds in parallel. The old sequential
  // 20-second searches could make Skip leave the voice channel silent for
  // 30-60+ seconds. Flat YouTube search is enough here because language and
  // genre are inferred from the artist/title maps below.
  const seedList = [...new Set(seeds)].slice(0, 3);
  const searchResults = await Promise.all(seedList.map(async seed => {
    try {
      console.log("🔎 Context autoplay search: " + seed);
      return { seed, entries: await search(seed) };
    } catch (error) {
      console.warn("⚠️ Context autoplay search failed: " + (error?.message || error));
      return { seed, entries: [] };
    }
  }));

  for (const result of searchResults) {
    const entries = result.entries;
    const seed = result.seed;
    for (const entry of entries) {
      const track = toTrack(entry, manager.client.user);
      if (!track) continue;
      const id = idOf(track);
      const canonical = canonicalTitle(titleOf(track));
      const identity = songIdentity(track);
      if (!id || !canonical || seen.has(id)) continue;
      seen.add(id);

      if (/\b(lyrics?|english version|hindi version|punjabi version|urdu version|arabic version|translation|translated|romanized|romanised|remix|cover|live|acoustic|instrumental|karaoke|nightcore|slowed|sped up|mashup|bootleg|fanmade|fan made|radio edit|club edit)\b/i.test(titleOf(track))) continue;
      if (isAlternateVersion(track)) continue;
      if (track.length < MIN_TRACK_MS || track.length > MAX_TRACK_MS) continue;
      if (ctx.title && canonical === canonicalTitle(ctx.title)) continue;
      if (recentIds.has(id) || recentSongs.has(identity) || recentTitles.has(canonical)) continue;

      const candidateLanguage = languageOf(track);
      if (language !== "unknown" && candidateLanguage !== language) continue;
      if (language !== "unknown" && candidateLanguage === "en" && language !== "en") continue;

      const candidateGenre = genreFamily(track.genre || track.category) || artistGenre(track) || genreFamily(seed);
      const sameGenre = !!targetGenre && candidateGenre === targetGenre;
      if (targetGenre && !sameGenre) continue;

      const artistMatch = sameArtist(artistOf(track), artist);
      const similarSignal = /similar artists|similar songs|songs like|similar to/.test(norm(seed));
      if (!similarSignal) continue;

      let score = officialSignal(track);
      if (sameGenre) score += 1000;
      if (language !== "unknown" && candidateLanguage === language) score += 1000;
      if (!artistMatch) score += 400;
      if (artistMatch) score += 50;
      if (track.length >= 90 * 1000 && track.length <= 6 * 60 * 1000) score += 25;

      candidates.push({track,score,artistMatch,sameGenre,candidateLanguage});
    }
  }

  if (!candidates.length) {
    console.warn("⚠️ No clean same-language + same-genre candidate found; refusing unrelated autoplay.");
    return null;
  }

  const differentArtist = candidates.filter(x => !x.artistMatch);
  const related = (differentArtist.length ? differentArtist : candidates).sort((a,b)=>b.score-a.score);
  const top = related[0].score;
  const pool = related.filter(x => x.score >= top - 120).slice(0,8);
  const chosen = pool[Math.floor(Math.random() * pool.length)] || related[0];

  console.log("🎯 Context autoplay selected: " + titleOf(chosen.track) + " [" +
    (chosen.sameGenre ? "same genre" : "related") + " • " +
    (chosen.candidateLanguage !== "unknown" ? "same language" : "unknown") + " • " +
    (chosen.artistMatch ? "same artist" : "different artist") + "]");

  return chosen.track;
}

if (!MusicManager.prototype.__deathOneByOneAutoplay) {
  MusicManager.prototype.__deathOneByOneAutoplay = true;

  if (!MusicManager.prototype.__gmaoOriginalSkip) {
    MusicManager.prototype.__gmaoOriginalSkip = MusicManager.prototype.skip;
  }

  MusicManager.prototype.autoplayNext = async function oneByOneAutoplay(guildId, options = {}) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);
    const preserveCurrent = Boolean(options?.preserveCurrent || options?.forceRelated);
    const previousTrack = state.current || player?.state?.resource?.metadata || null;

    if (!state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
    if ((state.current || state.queue.length) && !preserveCurrent) return false;

    state.autoplayBusy = true;

    try {
      const next = await findNext(this, state);

      if (!next) {
        console.warn("⚠️ No clean unused related track found; refusing unrelated autoplay.");
        return false;
      }

      next.isAutoplay = true;
      next.autoplayGroup = artistOf(state.autoplayContext)
        ? "Same artist / clean related"
        : "Same genre / clean related";

      addHistory(state, next);

      const id = idOf(next);

      state.autoplayContext = {
        title: titleOf(next),
        author: artistOf(next),
        artist: artistOf(next),
        genre: next.genre || state.autoplayContext?.genre || null,
        language: next.language || state.autoplayContext?.language || null,
        languageLocked: Boolean(state.autoplayContext?.languageLocked || state.autoplayContext?.language),
        genreLocked: Boolean(next.genre || state.autoplayContext?.genre || state.autoplayContext?.genreLocked),
        query: titleOf(next) + " " + artistOf(next),
        id
      };

      if (preserveCurrent && previousTrack) {
        this.destroyStream(guildId);
        try { player?.stop(true); } catch {}
        state.current = null;
        state.audioResource = null;
        state.startedAt = 0;
        state.positionOffset = 0;
      }

      try {
        await this.startTrack(guildId, next, 0, { handoff: true });
      } catch (error) {
        if (preserveCurrent && previousTrack && !state.current) {
          try {
            await this.startTrack(guildId, previousTrack, 0, { handoff: true });
            console.warn("⚠️ Skip replacement failed; restored previous track.");
          } catch {}
        }
        throw error;
      }

      state.queue = [];
      state.transitioning = false;

      console.log("♾️ 24/7 strict autoplay: " + titleOf(next) + " — " + artistOf(next));
      return true;
    } catch (error) {
      // During Skip/preserve-current mode the old track is intentionally kept
      // alive while searching. Never erase state.current just because search
      // returned no valid candidate.
      if (!preserveCurrent) state.current = null;
      state.transitioning = false;
      console.warn("⚠️ 24/7 strict autoplay track failed:", error?.message || error);
      return false;
    } finally {
      state.autoplayBusy = false;
    }
  };

  MusicManager.prototype.skip = async function strictSkip(guildId) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId);
    const current = state.current || player?.state?.resource?.metadata || null;

    if (!current || !state.autoplay || state.queue.length) {
      if (typeof MusicManager.prototype.__gmaoOriginalSkip === "function") {
        return MusicManager.prototype.__gmaoOriginalSkip.call(this, guildId);
      }
      return false;
    }

    if (state.autoplayBusy) return false;

    const oldTrack = state.current || current;
    try {
      const ok = await this.autoplayNext(guildId, { forceRelated: true, preserveCurrent: true });
      if (!ok && oldTrack && !state.current) {
        try { await this.startTrack(guildId, oldTrack, 0, { handoff: true }); } catch {}
      }
      return ok;
    } catch (error) {
      if (!state.current && oldTrack) {
        try { await this.startTrack(guildId, oldTrack, 0, { handoff: true }); } catch {}
      }
      console.warn("⚠️ Strict Skip failed:", error?.message || error);
      return false;
    }
  };

  MusicManager.prototype.__gmaoStrictSkip = MusicManager.prototype.skip;

  console.log("♾️ DEATH strict autoplay loaded: canonical dedupe + alternate-version rejection + artist/genre-only rotation.");
}
