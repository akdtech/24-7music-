"use strict";

/*
 * DEATH Music — surgical playback recovery.
 *
 * Loaded after directFinalFixPatch.js. We do not replace the existing search,
 * queue, autoplay, panel, or button system. If the normal YouTube/yt-dlp
 * resolver fails because YouTube serves a SABR/no-format response, use the
 * existing Piped resolver for the exact same YouTube video and feed that
 * audio into the existing Discord AudioPlayer.
 */

const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");
const MusicManager = require("./DirectMusicManager");

let getPipedStream = null;
try {
  ({ getPipedStream } = require("./directPipedPlaybackPatch"));
} catch {}

const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const PCM_TIMEOUT = 9000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36";

const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const ytId = value =>
  String(value || "").match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i
  )?.[1] || null;

const kill = processRef => {
  try { processRef?.kill("SIGKILL"); } catch {}
};

function retire(stream) {
  if (!stream) return;
  try { stream.ff?.stdout?.unpipe?.(); } catch {}
  try { stream.yt?.stdout?.unpipe?.(); } catch {}
  kill(stream.ff);
  kill(stream.yt);
  try { stream.pcm?.destroy?.(); } catch {}
}

async function firstPcm(ff) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      kill(ff);
      reject(new Error(
        "Piped audio produced no PCM within " +
        Math.round(PCM_TIMEOUT / 1000) +
        "s. " + clean(stderr).slice(-600)
      ));
    }, PCM_TIMEOUT);

    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    ff.stderr?.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    ff.stdout.once("data", chunk => {
      if (!chunk?.length) return fail(new Error("Piped returned empty audio."));
      settled = true;
      clearTimeout(timer);
      resolve(chunk);
    });

    ff.once("error", fail);
    ff.once("close", code => {
      if (!settled && code !== 0) {
        fail(new Error("FFmpeg exited " + code + ": " + clean(stderr).slice(-600)));
      }
    });
  });
}

if (!MusicManager.prototype.__deathPipedRecoveryFinal) {
  MusicManager.prototype.__deathPipedRecoveryFinal = true;

  const originalStartTrack = MusicManager.prototype.startTrack;

  MusicManager.prototype.startTrack = async function finalRecoveryStartTrack(
    guildId,
    track,
    startMs = 0,
    options = {}
  ) {
    try {
      return await originalStartTrack.call(this, guildId, track, startMs, options);
    } catch (originalError) {
      const id = ytId(track?.url) || ytId(track?.webpage_url) || null;

      if (!id || typeof getPipedStream !== "function") {
        throw originalError;
      }

      const state = this.getState(guildId);
      const player = this.players.get(guildId) || this.ensurePlayer(guildId);
      this.bindPlayerEvents(guildId, player);

      console.warn(
        "🛟 YouTube extractor failed; trying exact-video Piped recovery: " +
        this.getTrackTitle(track)
      );

      // Invalidate the failed attempt so any late async YouTube work cannot
      // replace the recovery resource.
      const token = Number(state.playbackToken || 0) + 1;
      state.playbackToken = token;
      state.pendingTrack = track;
      state.transitioning = true;

      let winner;
      let ff;

      try {
        winner = await getPipedStream(id);

        if (state.playbackToken !== token) {
          throw new Error("playback attempt superseded");
        }

        ff = spawn(FFMPEG, [
          "-hide_banner",
          "-loglevel", "error",
          "-nostdin",
          "-reconnect", "1",
          "-reconnect_streamed", "1",
          "-reconnect_delay_max", "5",
          "-user_agent", UA,
          "-i", winner.url,
          ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
          "-vn",
          "-af", "aresample=48000:async=1:first_pts=0",
          "-f", "s16le",
          "-ar", "48000",
          "-ac", "2",
          "pipe:1"
        ], { stdio: ["ignore", "pipe", "pipe"] });

        const first = await firstPcm(ff);

        if (state.playbackToken !== token) {
          kill(ff);
          throw new Error("playback attempt superseded");
        }

        const oldStream = this.streams.get(guildId);
        const resolvedTrack = {
          ...track,
          title: clean(winner.title) || track.title,
          author: clean(winner.author) || track.author,
          length: Number(winner.length || track.length || 0),
          thumbnail: track.thumbnail || winner.thumbnail || null,
          source: "piped-recovery"
        };

        const pcm = new PassThrough({ highWaterMark: 1024 * 1024 });
        const resource = createAudioResource(pcm, {
          inputType: StreamType.Raw,
          inlineVolume: true,
          metadata: resolvedTrack
        });

        resource.volume?.setVolume(
          Math.max(0.01, Number(state.volume || 70) / 100)
        );

        state.audioResource = resource;
        state.current = resolvedTrack;
        state.pendingTrack = null;
        state.transitioning = false;
        state.paused = false;
        state.startedAt = Date.now();
        state.positionOffset = Math.max(0, Number(startMs || 0));

        this.streams.set(guildId, {
          ff,
          pcm,
          resource,
          source: "piped-recovery"
        });

        pcm.write(first);
        ff.stdout.pipe(pcm);
        player.play(resource);

        if (options?.handoff !== false) {
          retire(oldStream);
        }

        Promise.resolve(this.updateVoiceStatus?.(
          guildId,
          "🎵 Playing: " + this.getTrackTitle(resolvedTrack)
        )).catch(() => {});
        Promise.resolve(this.refreshPanel?.(guildId)).catch(() => {});

        console.log(
          "✅ Exact-video Piped recovery started: " +
          this.getTrackTitle(resolvedTrack) +
          (winner.base ? " via " + winner.base : "")
        );

        return true;
      } catch (recoveryError) {
        kill(ff);
        if (state.playbackToken === token) {
          state.pendingTrack = null;
          state.transitioning = false;
        }

        console.warn(
          "❌ Exact-video Piped recovery failed: " +
          clean(recoveryError?.message || recoveryError).slice(-700)
        );

        // Preserve the original error so the existing command/error handling
        // remains unchanged when every source really is unavailable.
        throw originalError;
      }
    }
  };

  console.log(
    "🛟 DEATH final playback recovery loaded: exact YouTube video -> Piped fallback."
  );
}

module.exports = { ytId };
