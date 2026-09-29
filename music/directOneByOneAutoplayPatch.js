"use strict";

/* DEATH Music — one-at-a-time related autoplay. */
const { spawn } = require("node:child_process");
const MusicManager = require("./DirectMusicManager");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const MAX_TRACK_MS = 8 * 60 * 1000;
const RECENT_LIMIT = 40;
const BAD = /\b(playlist|mix|compilation|full album|album mix|nonstop|continuous|radio|medley|hour mix|meg[a -]?mix|collection|reaction|review|podcast|karaoke|cover)\b/i;

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const norm = v => clean(v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const idOf = t => String(t?.identifier || t?.id || t?.url || "").trim();
const artistOf = t => clean(t?.author || t?.uploader || t?.channel);
const titleOf = t => clean(t?.title);
const songKey = t => norm(titleOf(t) + " " + artistOf(t));

function sameArtist(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
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

async function findNext(manager, state) {
  const ctx = state.autoplayContext || {};
  const artist = clean(ctx.artist || ctx.author);
  const title = clean(ctx.title);
  const genre = clean(ctx.genre);
  const query = clean(ctx.query);

  console.log(
    "🧭 Autoplay context: " + (title || "Unknown") +
    " — " + (artist || "Unknown artist") +
    (genre ? " [" + genre + "]" : "")
  );

  // Autoplay context is always the song that just finished. When a manual
  // queue drains, DirectMusicManager updates this context to the last queued
  // song before calling us, so the chain follows A -> queued B -> related C.
  const seeds = [];
  if (artist && genre) seeds.push(artist + " " + genre + " official audio");
  if (artist) {
    seeds.push(artist + " official songs");
    seeds.push(artist + " related songs official audio");
  }
  if (title && artist) seeds.push(title + " " + artist + " similar songs official audio");
  if (title) seeds.push(title + " related songs official audio");
  if (genre) seeds.push(genre + " similar songs official audio");
  if (query) seeds.push(query + " similar songs official audio");
  if (!seeds.length) {
    seeds.push("popular songs official audio");
    seeds.push("trending songs official audio");
  }

  // Keep both YouTube IDs and normalized song identities. This prevents
  // different uploads of the same song from looping forever.
  const recentIds = new Set(Array.isArray(state.recent) ? state.recent.map(String) : []);
  const recentSongs = new Set(Array.isArray(state.recentSongs) ? state.recentSongs.map(String) : []);

  // Also remember the exact song that supplied the autoplay context. This
  // matters when the last queued song just ended: it must not immediately
  // become the next autoplay pick.
  if (ctx.id) recentIds.add(String(ctx.id));
  if (ctx.title || ctx.author) recentSongs.add(norm(ctx.title + " " + (ctx.artist || ctx.author || "")));

  if (state.current) {
    recentIds.add(idOf(state.current));
    recentSongs.add(songKey(state.current));
  }

  const candidates = [];
  const seenIds = new Set();
  const seenSongs = new Set();

  for (const seed of [...new Set(seeds)].slice(0, 5)) {
    try {
      console.log("🔎 24/7 related YouTube search: " + seed);
      const entries = await search(seed);

      for (const entry of entries) {
        const track = toTrack(entry, manager.client.user);
        if (!track) continue;

        const id = idOf(track);
        const key = songKey(track);
        if (!id || !key || seenIds.has(id) || seenSongs.has(key)) continue;
        seenIds.add(id);
        seenSongs.add(key);

        if (BAD.test(track.title)) continue;
        if (track.length <= 0 || track.length > MAX_TRACK_MS) continue;
        if (recentIds.has(id) || recentSongs.has(key)) continue;

        let score = 0;
        const trackArtist = artistOf(track);
        const trackTitle = titleOf(track);
        const trackGenre = norm(track.genre);

        // Build explicit relationship tiers. We must NEVER choose a generic
        // result just because it happened to score well.
        const artistMatch = !!(artist && sameArtist(trackArtist, artist));
        const genreMatch = !!(genre && trackGenre && trackGenre === genre);

        const contextWords = new Set(
          norm(title + " " + artist)
            .split(" ")
            .filter(word => word.length >= 3)
        );
        const hay = norm(trackTitle + " " + trackArtist);
        const contextMatches = [...contextWords].filter(word => hay.includes(word)).length;

        if (artistMatch) score += 1000;
        else if (genreMatch) score += 700;
        else if (contextMatches >= 2) score += 120;

        // Prefer official/topic/VEVO uploads without allowing this signal
        // to turn an unrelated song into an autoplay candidate.
        if (/\\b(official|vevo|topic)\\b/i.test(trackArtist + " " + trackTitle)) score += 30;

        const wantedWords = new Set(
          norm(title + " " + query)
            .split(" ")
            .filter(word => word.length >= 3)
        );
        for (const word of wantedWords) {
          if (hay.includes(word)) score += 8;
        }

        // Store the relationship explicitly so selection can enforce it.
        candidates.push({
          track,
          score,
          relation: artistMatch ? "Same Artist" : genreMatch ? "Same Genre" : contextMatches >= 2 ? "Song Context" : "Unrelated"
        });
        candidates.push({ track, score });
      }
    } catch (error) {
      console.warn("⚠️ Related autoplay search failed:", error?.message || error);
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);

  // Don't always select the first YouTube result. Choose among the strongest
  // few candidates so autoplay actually moves through different songs.
  // Strict priority: same artist > same genre > meaningful song context.
  // Unrelated search results are never eligible.
  const sameArtistCandidates = candidates.filter(item => item.relation === "Same Artist");
  const sameGenreCandidates = candidates.filter(item => item.relation === "Same Genre");
  const contextualCandidates = candidates.filter(item => item.relation === "Song Context");

  const related =
    sameArtistCandidates.length ? sameArtistCandidates :
    sameGenreCandidates.length ? sameGenreCandidates :
    contextualCandidates;

  if (!related.length) {
    console.warn("⚠️ No artist/genre/context match for autoplay; refusing unrelated track.");
    return null;
  }

  related.sort((a, b) => b.score - a.score);
  const topScore = related[0].score;
  const pool = related
    .filter(item => item.score >= Math.max(1, topScore - 80))
    .slice(0, 8);
  const selected = pool[Math.floor(Math.random() * pool.length)] || related[0];

  console.log(
    "🎯 Autoplay selected: " + titleOf(selected.track) +
    " [" + selected.relation + "] from context: " +
    title + " — " + artist
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
        console.warn("⚠️ No unused related YouTube track found; retrying later.");
        return false;
      }

      next.isAutoplay = true;
      next.autoplayGroup = state.autoplayContext?.artist
        ? "Same artist / related"
        : "Related music";

      const id = idOf(next);
      const key = songKey(next);

      state.recent = [...(state.recent || []), id].slice(-RECENT_LIMIT);
      state.recentSongs = [...(state.recentSongs || []), key].slice(-RECENT_LIMIT);

      // Continue from the NEW track, not the original search forever.
      state.autoplayContext = {
        title: titleOf(next),
        author: artistOf(next),
        artist: artistOf(next),
        query: titleOf(next) + " " + artistOf(next),
        id
      };

      await this.startTrack(guildId, next, 0, { handoff: true });
      state.queue = [];
      state.transitioning = false;

      console.log("♾️ 24/7 autoplay: " + titleOf(next) + " — " + artistOf(next));
      return true;
    } catch (error) {
      state.current = null;
      state.transitioning = false;
      console.warn("⚠️ 24/7 autoplay track failed:", error?.message || error);
      return false;
    } finally {
      state.autoplayBusy = false;
    }
  };

  console.log("♾️ DEATH one-by-one autoplay loaded: duplicate-safe related YouTube rotation.");
}
