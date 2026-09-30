const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Pause Discord voice playback."),
  async execute(i, { music }) {
    await i.deferReply({ ephemeral: true });
    await i.editReply("⏳ **Pausing music…**");
    try {
      await music.pause(i.guildId);
      return i.editReply("⏸️ **Music paused.**");
    } catch (error) {
      return i.editReply("❌ **Pause failed:** " + String(error?.message || error).slice(0, 1200));
    }
  }
};