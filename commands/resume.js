const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Resume Discord voice playback."),
  async execute(i, { music }) {
    await i.deferReply({ ephemeral: true });
    await i.editReply("⏳ **Resuming music…**");
    try {
      await music.resume(i.guildId);
      return i.editReply("▶️ **Music resumed.**");
    } catch (error) {
      return i.editReply("❌ **Resume failed:** " + String(error?.message || error).slice(0, 1200));
    }
  }
};