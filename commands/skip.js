const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("skip").setDescription("Skip the current Discord voice track."),
  async execute(interaction, { music }) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply("⏳ **Skip requested… finding the next track.**");
    try {
      const ok = await music.skip(interaction.guildId);
      return interaction.editReply(ok
        ? "⏭️ **Skip complete — next track is playing.**"
        : "❌ **Skip could not find/start a valid next track. Current playback was kept.**");
    } catch (error) {
      return interaction.editReply("❌ **Skip failed:** " + String(error?.message || error).slice(0, 1500));
    }
  }
};