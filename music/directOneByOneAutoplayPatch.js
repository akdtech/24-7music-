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
      "--no-warnings", "--no-progress", "--no-playlist", "--flat-playlist",
      "--playlist-end", "12", "--js-runtimes", "node",
      "--extractor-args", "youtube:player_client=web_music,web_embedded",
      "--remote-components", "ejs:github",
      "--dump-single-json",
      "ytsearch12:" + clean(query)
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "", err = "", done = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      if (!done) {
        done = true;
        reject(new Error("autoplay search timeout"));
      }
    }, 12000);

    child.stdout.on("data", c => out += c.toString());
    child.stderr.on("data", c => err += c.toString());

    child.on("error", e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(clean(err).slice(-1200) || "YouTube autoplay search failed"));
      }
      try {
        const parsed = JSON.parse(out || "{}");
        resolve(Array.isArray(parsed.entries) ? parsed.entries : []);
      } catch (e) {
        reject(e);
      }
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
    genre: clean(entry.genre || entry.category || ""),
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
  const query = clean(ctx.query);
  const hasContext = Boolean(artist || title || genre || query);

  console.log(
    "🧭 Autoplay context: " + (title || "Unknown") +
    " — " + (artist || "Unknown artist") +
    (genre ? " [" + genre + "]" : "")
  );

  const seeds = [];

  if (artist) {
    seeds.push(artist + " songs official audio");
    seeds.push(artist + " official songs");
    seeds.push(artist + " latest songs official audio");
    seeds.push(artist + " other songs official audio");
  }

  if (genre) {
    seeds.push(genre + " songs official audio");
    seeds.push(genre + " popular songs official audio");
  }

  if (title && artist) {
    seeds.push(artist + " " + title + " related songs official audio");
  }

  if (query && !artist) {
    seeds.push(query + " related songs official audio");
  }

  if (!seeds.length) seeds.push("popular songs official audio");

  const recentIds = new Set(Array.isArray(state.recent) ? state.recent.map(String) : []);
  const recentSongs = new Set(Array.isArray(state.recentSongs) ? state.recentSongs.map(String) : []);
  const recentTitles = new Set(Array.isArray(state.recentTitles) ? state.recentTitles.map(String) : []);

  if (ctx.id) recentIds.add(String(ctx.id));
  if (ctx.title || ctx.author) {
    recentSongs.add(songIdentity({ title: ctx.title, author: ctx.artist || ctx.author }));
    recentTitles.add(canonicalTitle(ctx.title));
  }

  if (state.current) {
    recentIds.add(idOf(state.current));
    recentSongs.add(songIdentity(state.current));
    recentTitles.add(titleIdentity(state.current));
  }

  const candidates = [];
  const seenIds = new Set();
  const seenSongs = new Set();

  for (const seed of [...new Set(seeds)].slice(0, 6)) {
    try {
      console.log("🔎 Strict related YouTube search: " + seed);
      const entries = await search(seed);

      for (const entry of entries) {
        const track = toTrack(entry, manager.client.user);
        if (!track) continue;

        const id = idOf(track);
        const song = songIdentity(track);
        const canonical = titleIdentity(track);

        if (!id || !song || !canonical) continue;
        if (seenIds.has(id) || seenSongs.has(song)) continue;

        seenIds.add(id);
        seenSongs.add(song);

        if (isAlternateVersion(track)) {
          console.log("⛔ Rejected alternate/unofficial-looking track: " + titleOf(track) + " — " + artistOf(track));
          continue;
        }

        if (track.length < MIN_TRACK_MS || track.length > MAX_TRACK_MS) continue;

        // Different YouTube ID is NOT enough. Reject the same canonical song
        // even when it comes from another upload or another artist.
        if (recentIds.has(id) || recentSongs.has(song) || recentTitles.has(canonical)) {
          console.log("⛔ Rejected duplicate song identity: " + titleOf(track) + " — " + artistOf(track));
          continue;
        }

        // Never pick another version of the current song.
        if (title && canonical === canonicalTitle(title)) {
          console.log("⛔ Rejected same canonical title: " + titleOf(track));
          continue;
        }

        const trackArtist = artistOf(track);
        const trackGenre = norm(track.genre);
        const artistMatch = !!(artist && sameArtist(trackArtist, artist));
        const genreMatch = !!(genre && trackGenre && trackGenre === norm(genre));

        // YouTube search often does not expose genre metadata. A candidate
        // returned from a dedicated genre query is therefore allowed as a
        // Same Genre candidate, provided it is not an artist-specific query.
        const genreSeed = !!genre && norm(seed).startsWith(norm(genre));
        const artistSeed = !!artist && norm(seed).includes(norm(artist));

        let relation = "Unrelated";
        let score = officialSignal(track);

        if (artistMatch) {
          relation = "Same Artist";
          score += 1000;
        } else if (genreMatch || (genreSeed && !artistSeed)) {
          relation = "Same Genre";
          score += 700;
        }

        if (track.length >= 90 * 1000 && track.length <= 6 * 60 * 1000) score += 25;
        if (artistMatch && canonical !== canonicalTitle(title)) score += 100;

        // Once a song exists, unrelated music is never an autoplay fallback.
        if (hasContext && relation === "Unrelated") continue;

        candidates.push({ track, score, relation });
      }
    } catch (error) {
      console.warn("⚠️ Strict related autoplay search failed:", error?.message || error);
    }
  }

  if (!candidates.length) return null;

  const sameArtistCandidates = candidates
    .filter(x => x.relation === "Same Artist")
    .sort((a, b) => b.score - a.score);

  const sameGenreCandidates = candidates
    .filter(x => x.relation === "Same Genre")
    .sort((a, b) => b.score - a.score);

  const related = sameArtistCandidates.length ? sameArtistCandidates : sameGenreCandidates;

  if (!related.length) {
    console.warn("⚠️ No valid same-artist/same-genre track found; refusing unrelated autoplay.");
    return null;
  }

  const topScore = related[0].score;
  const pool = related
    .filter(x => x.score >= Math.max(1, topScore - 90))
    .slice(0, 8);

  const selected = pool[Math.floor(Math.random() * pool.length)] || related[0];

  console.log(
    "🎯 Strict autoplay selected: " + titleOf(selected.track) +
    " [" + selected.relation + "] — " + artistOf(selected.track)
  );

  return selected.track;
}

if (!MusicManager.prototype.__deathOneByOneAutoplay) {
  MusicManager.prototype.__deathOneByOneAutoplay = true;

  MusicManager.prototype.autoplayNext = async function oneByOneAutoplay(guildId) {
    const state = this.getState(guildId);
    this.players.get(guildId) || this.ensurePlayer(guildId);

    if (!state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
    if (state.current || state.queue.length) return false;

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
        query: titleOf(next) + " " + artistOf(next),
        id
      };

      await this.startTrack(guildId, next, 0, { handoff: true });

      state.queue = [];
      state.transitioning = false;

      console.log("♾️ 24/7 strict autoplay: " + titleOf(next) + " — " + artistOf(next));
      return true;
    } catch (error) {
      state.current = null;
      state.transitioning = false;
      console.warn("⚠️ 24/7 strict autoplay track failed:", error?.message || error);
      return false;
    } finally {
      state.autoplayBusy = false;
    }
  };

  console.log("♾️ DEATH strict autoplay loaded: canonical dedupe + alternate-version rejection + artist/genre-only rotation.");
}
