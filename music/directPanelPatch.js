"use strict";

/* GMAO Music 24/7 — one persistent, pinned, live-synced player UI. */
const MusicManager = require("./DirectMusicManager");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { AudioPlayerStatus } = require("@discordjs/voice");

if (!MusicManager.prototype.__deathDirectPanelPatched) {
  MusicManager.prototype.__deathDirectPanelPatched = true;

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const format = ms => {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const bar = (position, duration) => {
    const slots = 18;
    if (!duration) return "━━━━━━━━━━━━━━━━━━";
    const ratio = Math.max(0, Math.min(1, position / duration));
    const filled = Math.min(slots - 1, Math.floor(ratio * slots));
    return `${"━".repeat(filled)}●${"━".repeat(Math.max(0, slots - filled - 1))}`;
  };
  const waveform = () => {
    const bars = ["▁","▂","▃","▄","▅","▆","▇","█"];
    const offset = Math.floor(Date.now() / 450) % bars.length;
    return Array.from({ length: 22 }, (_, i) => bars[(i * 3 + offset) % bars.length]).join("");
  };

  const button = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(false);

  MusicManager.prototype.ensurePanel = async function stickyEnsurePanel(guildId) {
    const state = this.getState(guildId);
    if (state.panelEditPromise) return state.panelEditPromise;

    const run = async () => {
      const channel = await this.findPanelChannel(guildId);
      if (!channel) throw new Error("Music panel channel is not available.");

      const player = this.players.get(guildId);
      const liveTrack = player?.state?.resource?.metadata;
      const current = liveTrack || state.current;
      if (liveTrack && liveTrack !== state.current) state.current = liveTrack;

      const playing = Boolean(current && player?.state.status === AudioPlayerStatus.Playing && !state.paused);
      const buffering = Boolean(current && player?.state.status === AudioPlayerStatus.Buffering);
      const paused = Boolean(current && (state.paused || player?.state.status === AudioPlayerStatus.Paused));
      const queued = state.queue.length;
      const duration = Number(current?.length || 0);
      const position = this.getPosition(guildId);
      const title = clean(current?.title) || (state.transitioning ? "Loading next track…" : "Nothing is playing");
      const author = clean(current?.author || current?.uploader) || "GMAO Music 24/7";
      const auto = Boolean(state.autoplay);
      const mode = current?.isAutoplay ? "♾️ Related autoplay" : "🎧 Manual selection";
      const status = state.actionStatus || (paused ? "⏸️ Paused" : playing ? "▶️ Playing" : buffering ? "⏳ Buffering" : state.transitioning ? "⏳ Loading" : "⏹️ Ready");

      const embed = new EmbedBuilder()
        .setColor(0x6C5CE7)
        .setAuthor({ name: "🎧 GMAO MUSIC • 24/7", iconURL: this.client.user.displayAvatarURL() })
        .setTitle(title)
        .setDescription(
          `🎤 **${author}**\n` +
          `> ${mode}\n\n` +
          `\`${bar(position, duration)}\`\n` +
          `\`${format(position)}\` / \`${format(duration)}\`  •  **${status}**\n` +
          `\`🎵 ${waveform()} 🎵\``
        )
        .addFields(
          { name: "📜 Queue", value: `**${queued}**`, inline: true },
          { name: "♾️ Autoplay", value: auto ? "**ON**" : "OFF", inline: true }
        )
        .setFooter({ text: "www.gmaog.com  •  DEATH × GMAOG" })
        .setTimestamp();

      if (current?.thumbnail && /^https?:\/\//i.test(current.thumbnail)) {
        try { embed.setImage(current.thumbnail); } catch {}
      }

      // Never disable the controls. A persistent music panel should remain
      // clickable even for a few seconds while the next source is loading.
      // The handlers below safely turn a click into the appropriate recovery
      // action instead of leaving users with dead-looking buttons.
      const row1 = new ActionRowBuilder().addComponents(
        button("death_music_pause", "Pause", "⏸️", ButtonStyle.Secondary),
        button("death_music_resume", "Play", "▶️", ButtonStyle.Success),
        button("death_music_skip", "Skip", "⏭️", ButtonStyle.Primary),
        button("death_music_queue", "Queue", "📜")
      );
      const row2 = new ActionRowBuilder().addComponents(
        button("death_music_autoplay", auto ? "Autoplay ON" : "Autoplay OFF", "♾️", auto ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

      // Deliberately no Volume or Shuffle controls. Volume stays configured
      // internally and autoplay selects the next related YouTube track.
      const payload = { embeds: [embed], components: [row1, row2] };
      let message = null;

      if (state.panelMessageId && state.panelChannelId === channel.id) {
        try { message = await channel.messages.fetch(state.panelMessageId); } catch { message = null; }
      }

      if (!message) {
        const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        const panels = messages
          ? [...messages.values()].filter(m => {
              if (m.author?.id !== this.client.user.id) return false;
              const title = clean(m.embeds?.[0]?.title);
              const author = clean(m.embeds?.[0]?.author?.name);
              const titleMatch = /GMAO\s+MUSIC\s*[•·-]?\s*24\/7/i.test(title) || /GMAO\s+Music\s+24\/7/i.test(title);
              const authorMatch = /GMAO\s+MUSIC\s+24\/7/i.test(author) || /DEATH\s+MUSIC\s+24\/7/i.test(author);
              const componentMatch = m.components?.some(row => row.components?.some(component => String(component.customId || "").startsWith("death_music_")));
              return titleMatch || authorMatch || componentMatch;
            })
          : [];

        message = panels[0] || null;
        if (message) {
          state.panelMessageId = message.id;
          state.panelChannelId = channel.id;
          for (const duplicate of panels.slice(1)) {
            try { await duplicate.delete(); } catch {}
          }
        }
      }

      if (message) {
        try {
          await message.edit(payload);
        } catch (error) {
          // The panel may have been deleted between fetch and edit. Clear the
          // stale ID and recreate it once instead of leaving the panel broken.
          if (error?.code === 10008 || /Unknown Message/i.test(String(error?.message || ""))) {
            state.panelMessageId = null;
            state.panelChannelId = null;
            message = await channel.send(payload);
            state.panelMessageId = message.id;
            state.panelChannelId = channel.id;
          } else {
            throw error;
          }
        }
      } else {
        message = await channel.send(payload);
        state.panelMessageId = message.id;
        state.panelChannelId = channel.id;
      }

      if (message && !message.pinned) {
        await message.pin("GMAO Music 24/7 persistent control panel").catch(() => {});
      }
      return message;
    };

    const previous = state.panelEditPromise || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    let wrapped;
    wrapped = next.finally(() => {
      if (state.panelEditPromise === wrapped) state.panelEditPromise = null;
    });
    state.panelEditPromise = wrapped;
    return wrapped;
  };

  if (!MusicManager.prototype.__gmaoLiveAnimation) {
    MusicManager.prototype.__gmaoLiveAnimation = true;
    const originalSetup = MusicManager.prototype.setupPlayerEvents;
    MusicManager.prototype.setupPlayerEvents = function gmaoAnimatedSetup() {
      originalSetup.call(this);
      this.client.once("ready", () => {
        if (this.__gmaoAnimationTimer) return;
        this.__gmaoAnimationTimer = setInterval(() => {
          const guildId = this.musicGuildId;
          if (!guildId) return;
          const state = this.getState(guildId);
          if (state.permanent && !state.intentionalLeave && state.current) {
            this.refreshPanel(guildId).catch(() => {});
          }
        }, 4000);
        console.log("🎚️ GMAO music panel live animation active.");
      });
    };
  }

  // The legacy DirectMusicManager has its own movePanelToBottom() which builds the old
  // Volume/Loop/Shuffle/Stop/Refresh UI. Override it here so sticky-panel recreation
  // can NEVER resurrect those controls.
  // Discord does not support moving an existing message to the bottom of a
  // channel. Deleting + re-sending creates the "panel spam" the user sees.
  // Keep ONE persistent message and edit it in place instead.
  MusicManager.prototype.movePanelToBottom = async function canonicalMovePanelToBottom(guildId) {
    const state = this.getState(guildId);
    try {
      const channel = await this.findPanelChannel(guildId);
      if (!channel) throw new Error("Music panel channel is not available.");

      let oldPanel = null;
      if (state.panelMessageId && state.panelChannelId === channel.id) {
        try { oldPanel = await channel.messages.fetch(state.panelMessageId); } catch {}
      }

      // Discord cannot reposition a message. Recreate it only after the quiet
      // period, but ALWAYS recreate through the rich ensurePanel() renderer.
      // Never call the legacy buildPanelPayload() here: that renderer contains
      // the old Volume/Loop/Shuffle/Stop/Refresh controls.
      if (oldPanel) {
        await oldPanel.delete();
      }

      state.panelMessageId = null;
      state.panelChannelId = null;

      const newPanel = await this.ensurePanel(guildId);
      if (newPanel && !newPanel.pinned) {
        await newPanel.pin("GMAO Music 24/7 panel moved to channel bottom").catch(() => {});
      }

      console.log("📌 GMAO music panel moved to channel bottom with the current GMAO UI.");
      return Boolean(newPanel);
    } catch (error) {
      console.warn("⚠️ Delayed music panel move failed:", error?.message || error);
      return false;
    }
  };

  MusicManager.prototype.refreshPanel = async function deathRichRefreshPanel(guildId) {
    try {
      await this.ensurePanel(guildId);
      return true;
    } catch (error) {
      console.warn(`⚠️ Rich music panel refresh failed: ${error?.message || error}`);
      return false;
    }
  };

  console.log("🎨 GMAO Music panel loaded: five controls + live animation.");
}
