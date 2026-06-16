import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, TextChannel, REST, Routes, SlashCommandBuilder } from 'discord.js';
import express, { Request, Response } from 'express';

const rawToken = process.env.DISCORD_BOT_TOKEN;
const rawChannelId = process.env.DISCORD_CHANNEL_ID;

if (!rawToken) {
  console.error('Missing required env var: DISCORD_BOT_TOKEN');
  process.exit(1);
}
if (!rawChannelId) {
  console.error('Missing required env var: DISCORD_CHANNEL_ID');
  process.exit(1);
}

const BOT_TOKEN: string = rawToken;
const CHANNEL_ID: string = rawChannelId;
const MPLUS_PING_ROLE_ID = process.env.MPLUS_PING_ROLE_ID;
const ROSTER_PING_ROLE_ID = process.env.ROSTER_PING_ROLE_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TEAM_NAME = process.env.TEAM_NAME ?? 'Team';
const PORT = process.env.PORT ?? '3000';

const commands = [
  new SlashCommandBuilder()
    .setName('resend')
    .setDescription('Re-send the last N M+ exclusion submissions from the Google Form')
    .addIntegerOption(opt =>
      opt.setName('count')
        .setDescription('Number of submissions to resend (1-20)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20)
    )
    .toJSON(),
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`Bot ready: ${client.user?.tag}`);
  if (GUILD_ID) {
    const rest = new REST().setToken(BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user!.id, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  }
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'resend') return;

  if (!APPS_SCRIPT_URL) {
    await interaction.reply({ content: 'APPS_SCRIPT_URL is not configured.', ephemeral: true }).catch(() => null);
    return;
  }

  const count = interaction.options.getInteger('count', true);

  try {
    await interaction.deferReply();
  } catch {
    return;
  }

  try {
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('secret', WEBHOOK_SECRET ?? '');
    url.searchParams.set('n', String(count));
    const response = await fetch(url.toString());
    const data = await response.json() as { ok?: boolean; error?: string; sent?: number };
    if (data.ok) {
      await interaction.editReply(`Resending the last **${data.sent}** M+ submission(s).`);
    } else {
      await interaction.editReply(`Failed: ${data.error ?? 'Unknown error'}`);
    }
  } catch {
    await interaction.editReply('Failed to contact Apps Script. Check the logs.').catch(() => null);
  }
});

client.login(BOT_TOKEN);

const app = express();
app.use(express.json());

app.get('/', (_req: Request, res: Response) => {
  res.send(`${TEAM_NAME} bot is running.`);
});

function checkSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function fetchTextChannel(res: Response): Promise<TextChannel | null> {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel || !(channel instanceof TextChannel)) {
    res.status(500).json({ error: 'Channel not found or not a text channel' });
    return null;
  }
  return channel;
}

// --- M+ Exclusion submissions ---

interface MplusBody {
  characterName?: string;
  nameRealm?: string;
  mplusLink?: string;
  raiderioUrl?: string;
  raidLink?: string;
  notes?: string;
  submittedAt?: string;
}

app.post('/mplus', async (req: Request, res: Response): Promise<void> => {
  if (!checkSecret(req, res)) return;

  const { characterName, nameRealm, mplusLink, raiderioUrl, raidLink, notes, submittedAt } =
    req.body as MplusBody;

  const playerName = nameRealm || characterName;
  const profileUrl = raiderioUrl || mplusLink;

  if (!playerName || !profileUrl) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const channel = await fetchTextChannel(res);
  if (!channel) return;

  const unixTs = submittedAt
    ? Math.floor(new Date(submittedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('New M+ Exclusion Request')
    .addFields(
      { name: 'Player', value: playerName },
      { name: 'Submitted At', value: `<t:${unixTs}:f>` },
      { name: 'Raider.io / Profile', value: profileUrl },
      ...(raidLink ? [{ name: 'Raid Droptimizer', value: raidLink }] : []),
      { name: 'Notes', value: notes ?? '*(none)*' },
    )
    .setFooter({ text: 'M+ Exclusion Request System' });

  if (MPLUS_PING_ROLE_ID) {
    await channel.send({
      content: `<@&${MPLUS_PING_ROLE_ID}> New M+ exclusion request received!`,
      embeds: [embed],
    });
  } else {
    await channel.send({ embeds: [embed] });
  }

  res.json({ ok: true });
});

// --- Roster submissions ---

interface RosterBody {
  characterName?: string;
  classSpec?: string;
  notes?: string;
  submittedAt?: string;
}

app.post('/roster', async (req: Request, res: Response): Promise<void> => {
  if (!checkSecret(req, res)) return;

  const { characterName, classSpec, notes, submittedAt } =
    req.body as RosterBody;

  if (!characterName || !classSpec) {
    res.status(400).json({ error: 'Missing required fields: characterName, classSpec' });
    return;
  }

  const channel = await fetchTextChannel(res);
  if (!channel) return;

  const unixTs = submittedAt
    ? Math.floor(new Date(submittedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('New Roster Application')
    .addFields(
      { name: 'Character Name', value: characterName },
      { name: 'Class / Spec', value: classSpec },
      { name: 'Submitted At', value: `<t:${unixTs}:f>` },
      { name: 'Notes', value: notes ?? '*(none)*' },
    )
    .setFooter({ text: 'Roster Application System' });

  if (ROSTER_PING_ROLE_ID) {
    await channel.send({
      content: `<@&${ROSTER_PING_ROLE_ID}> New roster application received!`,
      embeds: [embed],
    });
  } else {
    await channel.send({ embeds: [embed] });
  }

  res.json({ ok: true });
});

// --- Raid signups ---

interface SignupBody {
  charName?: string;
  realm?: string;
  className?: string;
  mainSpec?: string;
  offSpecs?: string;
  role?: string;
  discord?: string;
  notes?: string;
  submittedAt?: string;
}

app.post('/signup', async (req: Request, res: Response): Promise<void> => {
  if (!checkSecret(req, res)) return;

  const { charName, realm, className, mainSpec, offSpecs, role, discord, notes, submittedAt } =
    req.body as SignupBody;

  if (!charName || !className || !mainSpec) {
    res.status(400).json({ error: 'Missing required fields: charName, className, mainSpec' });
    return;
  }

  const channel = await fetchTextChannel(res);
  if (!channel) return;

  const unixTs = submittedAt
    ? Math.floor(new Date(submittedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('New Raid Signup')
    .addFields(
      { name: 'Character', value: realm ? `${charName}-${realm}` : charName },
      { name: 'Class / Main Spec', value: `${className} — ${mainSpec}` },
      { name: 'Role', value: role ?? 'N/A', inline: true },
      { name: 'Off Specs', value: offSpecs || '*(none)*', inline: true },
      { name: 'Discord', value: discord || '*(not provided)*', inline: true },
      { name: 'Submitted At', value: `<t:${unixTs}:f>` },
      { name: 'Notes', value: notes || '*(none)*' },
    )
    .setFooter({ text: 'Raid Signup System' });

  if (ROSTER_PING_ROLE_ID) {
    await channel.send({
      content: `<@&${ROSTER_PING_ROLE_ID}> New raid signup received!`,
      embeds: [embed],
    });
  } else {
    await channel.send({ embeds: [embed] });
  }

  res.json({ ok: true });
});

// --- Self-received item requests ---

interface SelfReceivedBody {
  player?: string;
  item?: string;
  slot?: string;
  source?: string;
  notes?: string;
  submittedAt?: string;
}

app.post('/selfreceived', async (req: Request, res: Response): Promise<void> => {
  if (!checkSecret(req, res)) return;

  const { player, item, slot, source, notes, submittedAt } =
    req.body as SelfReceivedBody;

  if (!player || !item) {
    res.status(400).json({ error: 'Missing required fields: player, item' });
    return;
  }

  const channel = await fetchTextChannel(res);
  if (!channel) return;

  const unixTs = submittedAt
    ? Math.floor(new Date(submittedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('New Self-Received Request')
    .addFields(
      { name: 'Player', value: player },
      { name: 'Item', value: item },
      { name: 'Slot', value: slot || 'N/A', inline: true },
      { name: 'Source', value: source || 'N/A', inline: true },
      { name: 'Submitted At', value: `<t:${unixTs}:f>` },
      { name: 'Notes', value: notes || '*(none)*' },
    )
    .setFooter({ text: 'Self-Received Request System' });

  if (ROSTER_PING_ROLE_ID) {
    await channel.send({
      content: `<@&${ROSTER_PING_ROLE_ID}> New self-received request received!`,
      embeds: [embed],
    });
  } else {
    await channel.send({ embeds: [embed] });
  }

  res.json({ ok: true });
});

// --- BiS list submissions ---

interface BiSBody {
  nameRealm?: string;
  bisLink?: string;
  notes?: string;
  submittedAt?: string;
}

app.post('/bis', async (req: Request, res: Response): Promise<void> => {
  if (!checkSecret(req, res)) return;

  const { nameRealm, bisLink, notes, submittedAt } =
    req.body as BiSBody;

  if (!nameRealm || !bisLink) {
    res.status(400).json({ error: 'Missing required fields: nameRealm, bisLink' });
    return;
  }

  const channel = await fetchTextChannel(res);
  if (!channel) return;

  const unixTs = submittedAt
    ? Math.floor(new Date(submittedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('New BiS List Submission')
    .addFields(
      { name: 'Player', value: nameRealm },
      { name: 'Submitted At', value: `<t:${unixTs}:f>` },
      { name: 'BiS List', value: bisLink },
      { name: 'Notes', value: notes || '*(none)*' },
    )
    .setFooter({ text: 'BiS List System' });

  if (ROSTER_PING_ROLE_ID) {
    await channel.send({
      content: `<@&${ROSTER_PING_ROLE_ID}> New BiS list submission received!`,
      embeds: [embed],
    });
  } else {
    await channel.send({ embeds: [embed] });
  }

  res.json({ ok: true });
});

app.listen(Number(PORT), () => {
  console.log(`Server listening on port ${PORT}`);
});
