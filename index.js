const { Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_NAME = 'logs';

const DEFAULT_TOLERANCE = 20;
const ANALYSE_DURATION = 60 * 1000;
const MIN_OBSERVATIONS = 5;
const MAX_HISTORY = 10;

const PROFILE_PATH = './userProfiles.json';
let userProfiles = {};
if (fs.existsSync(PROFILE_PATH)) {
  userProfiles = JSON.parse(fs.readFileSync(PROFILE_PATH));
}
function saveProfiles() {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(userProfiles, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

let isMonitoring = false;

function getGlobalAverageMax() {
  const allVolumes = Object.values(userProfiles)
    .filter(p => p.history.length >= MIN_OBSERVATIONS)
    .flatMap(p => p.history);

  if (allVolumes.length === 0) return null;

  return allVolumes.reduce((a, b) => a + b, 0) / allVolumes.length;
}

// Nouvelle fonction centralisée pour calculer le seuil de kick
function getKickThreshold(userId) {
  const profile = userProfiles[userId];
  const adjustment = profile ? profile.adjustment : 0;
  const avg = profile && profile.history.length >= MIN_OBSERVATIONS
    ? profile.history.reduce((a, b) => a + b, 0) / profile.history.length
    : getGlobalAverageMax();
  if (avg === null) return null;
  return avg + DEFAULT_TOLERANCE + adjustment;
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options, member, guild } = interaction;

  if (commandName === 'analyse') {
    if (!member.voice || !member.voice.channel) {
      return interaction.reply({ content: '❌ Tu dois être dans un salon vocal.', ephemeral: true });
    }
    const channel = member.voice.channel;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator
    });

    await interaction.reply('🔍 Analyse des utilisateurs en cours pendant 60 secondes...');

    connection.receiver.speaking.on('start', (userId) => {
      const user = channel.members.get(userId);
      if (!user || user.user.bot) return;

      const opusStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
      });

      const ffmpegProcess = spawn(ffmpeg, [
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-i', 'pipe:0', '-filter:a', 'volumedetect', '-f', 'null', '-'
      ]);

      const pcm = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      opusStream.pipe(pcm).pipe(ffmpegProcess.stdin);

      let stderr = '';
      ffmpegProcess.stderr.on('data', data => stderr += data.toString());

      ffmpegProcess.on('close', () => {
        const maxMatch = stderr.match(/max_volume: ([-\d.]+) dB/);
        if (!maxMatch) return;

        const maxVol = parseFloat(maxMatch[1]);
        const id = user.id;
        if (!userProfiles[id]) userProfiles[id] = { history: [], adjustment: 0 };
        const profile = userProfiles[id];

        if (profile.history.length >= MAX_HISTORY) profile.history.shift();
        profile.history.push(maxVol);
        saveProfiles();

        console.log(`📊 [ANALYSE] ${user.user.username} - Volume max: ${maxVol.toFixed(1)} dB (enregistré)`);
      });
    });

    setTimeout(() => {
      connection.destroy();
      interaction.followUp('✅ Fin de l\'analyse. Les données ont été enregistrées.');
    }, ANALYSE_DURATION);
  }

  if (commandName === 'join') {
    if (!member.voice || !member.voice.channel) {
      return interaction.reply({ content: '❌ Tu dois être dans un salon vocal.', ephemeral: true });
    }
    const channel = member.voice.channel;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator
    });

    isMonitoring = true;
    await interaction.reply('👂 Surveillance active. Les utilisateurs seront déconnectés s\'ils dépassent leur seuil.');

    connection.receiver.speaking.on('start', (userId) => {
      const user = channel.members.get(userId);
      if (!user || user.user.bot || !isMonitoring) return;

      console.log(`🎧 Début de stream pour ${user.user.username}`);

      const opusStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
      });

      const ffmpegProcess = spawn(ffmpeg, [
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-i', 'pipe:0', '-filter:a', 'volumedetect', '-f', 'null', '-'
      ]);

      const pcm = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      opusStream.pipe(pcm).pipe(ffmpegProcess.stdin);

      let stderr = '';
      ffmpegProcess.stderr.on('data', data => stderr += data.toString());

      ffmpegProcess.on('close', async () => {
        const maxMatch = stderr.match(/max_volume: ([-\d.]+) dB/);
        if (!maxMatch) return;

        const maxVol = parseFloat(maxMatch[1]);
        const threshold = getKickThreshold(user.id);
        if (threshold === null) return; // Pas assez de données pour calculer le seuil
        const diff = (maxVol - threshold).toFixed(1);

        console.log(`🎙️ ${user.user.username} - Volume détecté: ${maxVol.toFixed(1)} dB | Seuil: ${threshold.toFixed(1)} dB | Diff: ${diff} dB`);

        if (maxVol > threshold) {
          try {
            await user.voice.disconnect();
            const log = `🚫 ${user.user.username} déconnecté : volume ${maxVol.toFixed(1)} dB > seuil ${threshold.toFixed(1)} dB`;
            sendLog(guild, log);
            console.log(log);
          } catch (err) {
            sendLog(guild, `❌ Échec de déconnexion : ${err.message}`);
          }
        }
      });
    });
  }

  if (commandName === 'adjust') {
    const target = options.getUser('utilisateur');
    const valeur = options.getInteger('valeur');
    if (!target || valeur === null) return interaction.reply({ content: '❌ Paramètres invalides.', ephemeral: true });

    if (!userProfiles[target.id]) userProfiles[target.id] = { history: [], adjustment: 0 };
    userProfiles[target.id].adjustment += valeur;
    saveProfiles();

    return interaction.reply(`🔧 Ajustement appliqué à ${target.username} : ${valeur} dB (total: ${userProfiles[target.id].adjustment} dB)`);
  }

  if (commandName === 'info') {
    const target = options.getUser('utilisateur');
    const profile = userProfiles[target.id];
    const avg = profile && profile.history.length
      ? profile.history.reduce((a, b) => a + b, 0) / profile.history.length
      : getGlobalAverageMax();
    const adjustment = profile ? profile.adjustment : 0;
    const threshold = getKickThreshold(target.id);

    return interaction.reply(`📈 ${target.username} :
- Moyenne max : ${avg ? avg.toFixed(1) : 'Pas de donnée'} dB
- Seuil de kick : ${typeof threshold === 'number' ? threshold.toFixed(1) : 'Indéfini'} dB
- Tolérance personnalisée : ${adjustment} dB`);
  }
});

async function sendLog(guild, message) {
  const logChannel = guild.channels.cache.find(
    ch => ch.name === LOG_CHANNEL_NAME && ch.isTextBased()
  );
  if (logChannel) logChannel.send(message).catch(console.error);
}

const commands = [
  new SlashCommandBuilder().setName('analyse').setDescription('Analyse les utilisateurs du vocal pendant 60 secondes'),
  new SlashCommandBuilder().setName('join').setDescription('Active la surveillance vocale'),
  new SlashCommandBuilder().setName('adjust').setDescription('Ajuste la tolérance pour un utilisateur')
    .addUserOption(opt => opt.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addIntegerOption(opt => opt.setName('valeur').setDescription('Décibels à ajouter/enlever').setRequired(true)),
  new SlashCommandBuilder().setName('info').setDescription('Affiche les infos de seuil pour un utilisateur')
    .addUserOption(opt => opt.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    console.log('📥 Enregistrement des commandes slash...');
    await rest.put(Routes.applicationCommands(CLIENT_ID),{ body: commands });

    console.log('✅ Commandes enregistrées.');
  } catch (error) {
    console.error(error);
  }
})();

client.login(TOKEN);
