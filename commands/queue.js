const { SlashCommandBuilder } = require("discord.js");
const { embed } = require("../music/helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current song and queued tracks."),
  async execute(i, { music }) {
    const tracks = music.getQueue(i.guild.id);
    if (!tracks.length) return i.reply("📭 Queue is empty.");

    const current = tracks[0];
    const upcoming = tracks.slice(1, 16);

    let description = `▶️ **Now playing:** ${current.title} — ${current.author || "Unknown artist"}`;
    if (upcoming.length) {
      description += "\\n\\n" + upcoming
        .map((t, n) => `${n + 1}. **${t.title}** — ${t.author || "Unknown artist"}`)
        .join("\\n");
    } else {
      description += "\\n\\n📭 **No upcoming tracks.**";
    }

    await i.reply({
      embeds: [embed("🎵 GMAO Music Queue", description)]
    });
  }
};
