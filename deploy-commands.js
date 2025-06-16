require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('analyse').setDescription('Analyse les utilisateurs du vocal pendant 60 secondes'),
  new SlashCommandBuilder().setName('join').setDescription('Active la surveillance vocale'),
  new SlashCommandBuilder().setName('adjust').setDescription('Ajuste la tolérance pour un utilisateur')
    .addUserOption(opt => opt.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addIntegerOption(opt => opt.setName('valeur').setDescription('Décibels à ajouter/enlever').setRequired(true)),
  new SlashCommandBuilder().setName('info').setDescription('Affiche les infos de seuil pour un utilisateur')
    .addUserOption(opt => opt.setName('utilisateur').setDescription('Utilisateur').setRequired(true)),
  new SlashCommandBuilder().setName('fin').setDescription('Déconnecte le bot du vocal')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('📥 Enregistrement des commandes slash...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commandes enregistrées !');
  } catch (error) {
    console.error(error);
  }
})();
