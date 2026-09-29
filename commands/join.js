const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel."),
  async execute(i, { music }) {
    if (!i.guildId) return i.reply({ content: "❌ Server only.", ephemeral: true });
    if (!i.member?.voice?.channel) {
      return i.reply({ content: "❌ Join a voice channel first.", ephemeral: true });
    }

    // A voice join can legitimately take several seconds. Acknowledge the
    // interaction immediately so Discord does not expire it while we connect.
    await i.deferReply();

    try {
      await music.join(i.guild, i.member.voice.channel);

      await i.editReply(
        "🎵 **DEATH × GMAO** joined your voice channel."
      );
    } catch (error) {
      console.error("❌ /join error:", error);
      const message = String(error?.message || error)
        .replace(/\s+/g, " ")
        .slice(0, 1800);

      try {
        await i.editReply("❌ Could not join the voice channel: " + message);
      } catch (replyError) {
        if (replyError?.code !== 10008) {
          console.warn("⚠️ /join response failed:", replyError?.message || replyError);
        }
      }
    }
  }
};
