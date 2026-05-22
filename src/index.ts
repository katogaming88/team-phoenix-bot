import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, TextChannel } from 'discord.js';
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
const PORT = process.env.PORT ?? '3000';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`Bot ready: ${client.user?.tag}`);
});

client.login(BOT_TOKEN);

const app = express();
app.use(express.json());

app.get('/', (_req: Request, res: Response) => {
  res.send('Team Phoenix bot is running.');
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
  mplusLink?: string;
  raidLink?: string;
  notes?: string;
  submittedAt?: string;
}

app.post('/mplus', async (req: Request, res: Response): Promise<void> => {
  if (!checkSecret(req, res)) return;

  const { characterName, mplusLink, raidLink, notes, submittedAt } =
    req.body as MplusBody;

  if (!characterName || !mplusLink) {
    res.status(400).json({ error: 'Missing required fields: characterName, mplusLink' });
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
      { name: 'Character Name', value: characterName },
      { name: 'Submitted At', value: `<t:${unixTs}:f>` },
      { name: 'M+ Droptimizer/QE Report', value: mplusLink },
      { name: 'Raid Droptimizer', value: raidLink ?? 'N/A' },
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

app.listen(Number(PORT), () => {
  console.log(`Server listening on port ${PORT}`);
});
