const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Le bot rejoint ton salon vocal')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

rest.put(
  Routes.applicationCommands('1383837777845555280'),
  { body: commands }
).then(() => console.log('Commandes enregistrées.'));
