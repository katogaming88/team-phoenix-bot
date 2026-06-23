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
const ROSTER_SCRIPT_URL = process.env.ROSTER_SCRIPT_URL;
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
  new SlashCommandBuilder()
    .setName('pending-roster')
    .setDescription('List all current pending signup applicants')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('trials')
    .setDescription('List all players currently on trial with how long they have been on the roster')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('bench')
    .setDescription('List all benched players')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('attendance')
    .setDescription('Show attendance percentage for a specific player')
    .addStringOption(opt =>
      opt.setName('player')
        .setDescription('Player first name (e.g. Katorri)')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('absences')
    .setDescription('List players currently below the attendance threshold')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('mplus-excluded')
    .setDescription('List all players approved for M+ exclusion')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('fairness')
    .setDescription('Quick loot distribution summary -- who has received the most vs least items this tier')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('officers')
    .setDescription('List current officers and their claimed Discord usernames')
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

// ── Roster script fetch helpers ──────────────────────────────────────────────

interface CorePayload {
  roster: RosterPlayer[];
  trialAttend: number;
  trialWeeks: number;
  officerDiscordIds: string[];
  discordClaims: DiscordClaim[];
  seasonName: string;
}

interface HeavyPayload {
  lootCounts: Record<string, LootCount>;
}

interface PendingRosterPayload {
  entries: PendingEntry[];
}

interface RosterPlayer {
  nameRealm: string;
  firstName: string;
  class: string;
  spec: string;
  role: string;
  isTrial: boolean;
  isBench: boolean;
  mPlusExcluded: boolean;
  mPlusNote: string;
  attendance: string;
  joinDate: string;
}

interface LootCount {
  count: number;
  heroicCount: number;
  mythicCount: number;
  items: { name: string; difficulty: string; date: string }[];
}

interface DiscordClaim {
  discordId: string;
  username: string;
  nameRealm: string;
}

interface PendingEntry {
  nameRealm: string;
  className: string;
  mainSpec: string;
  offSpecs: string;
  role: string;
  discord: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchRosterScript(params: Record<string, string>): Promise<any> {
  if (!ROSTER_SCRIPT_URL) throw new Error('ROSTER_SCRIPT_URL is not configured.');
  const url = new URL(ROSTER_SCRIPT_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Roster script returned ${res.status}`);
  return res.json();
}

async function fetchCorePayload(): Promise<CorePayload> {
  return fetchRosterScript({ chunk: 'core' });
}

async function fetchHeavyPayload(): Promise<HeavyPayload> {
  return fetchRosterScript({ chunk: 'heavy' });
}

async function fetchPendingRoster(): Promise<PendingRosterPayload> {
  return fetchRosterScript({ action: 'getPendingRoster' });
}

// Returns how long ago a YYYY-MM-DD date was in a readable form
function daysAgo(dateStr: string): string {
  if (!dateStr) return 'unknown';
  const joined = new Date(dateStr);
  if (isNaN(joined.getTime())) return dateStr;
  const days = Math.floor((Date.now() - joined.getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  if (days < 14) return `${days} days`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} wk`;
  const months = Math.floor(days / 30);
  return `${months} mo`;
}

// Truncate a text list to fit within Discord's embed description limit
function truncateLines(lines: string[], limit = 3800): string {
  let out = '';
  let i = 0;
  for (; i < lines.length; i++) {
    const next = out ? out + '\n' + lines[i] : lines[i];
    if (next.length > limit) break;
    out = next;
  }
  const remaining = lines.length - i;
  if (remaining > 0) out += `\n... and ${remaining} more`;
  return out;
}

// ── Slash command interaction handler ────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  // ── /resend ──────────────────────────────────────────────────────────────
  if (cmd === 'resend') {
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
    return;
  }

  // All remaining commands are ephemeral officer queries
  if (!ROSTER_SCRIPT_URL) {
    await interaction.reply({ content: 'ROSTER_SCRIPT_URL is not configured.', ephemeral: true }).catch(() => null);
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch {
    return;
  }

  try {
    // ── /pending-roster ───────────────────────────────────────────────────
    if (cmd === 'pending-roster') {
      const data = await fetchPendingRoster();
      const entries = data.entries ?? [];
      if (!entries.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('Pending Roster').setDescription('No pending applicants.')] });
        return;
      }
      const lines = entries.map(e => {
        const name = e.nameRealm || '?';
        const cls  = [e.className, e.mainSpec].filter(Boolean).join(' ');
        const role = e.role || '';
        const disc = e.discord ? ` | ${e.discord}` : '';
        return `**${name}** — ${cls} (${role})${disc}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`Pending Roster (${entries.length})`)
        .setDescription(truncateLines(lines));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /trials ───────────────────────────────────────────────────────────
    if (cmd === 'trials') {
      const core = await fetchCorePayload();
      const trials = (core.roster ?? []).filter(p => p.isTrial);
      if (!trials.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('Trials').setDescription('No players currently on trial.')] });
        return;
      }
      const lines = trials.map(p => {
        const cls  = [p.class, p.spec].filter(Boolean).join(' ');
        const dur  = daysAgo(p.joinDate);
        const att  = p.attendance || 'N/A';
        return `**${p.nameRealm}** — ${cls} (${p.role}) | joined ${dur} ago | ${att}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`Trials (${trials.length})`)
        .setDescription(truncateLines(lines));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /bench ────────────────────────────────────────────────────────────
    if (cmd === 'bench') {
      const core = await fetchCorePayload();
      const benched = (core.roster ?? []).filter(p => p.isBench);
      if (!benched.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('Bench').setDescription('No players currently benched.')] });
        return;
      }
      const lines = benched.map(p => {
        const cls = [p.class, p.spec].filter(Boolean).join(' ');
        const att = p.attendance || 'N/A';
        return `**${p.nameRealm}** — ${cls} (${p.role}) | ${att}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x7f8c8d)
        .setTitle(`Bench (${benched.length})`)
        .setDescription(truncateLines(lines));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /attendance <player> ──────────────────────────────────────────────
    if (cmd === 'attendance') {
      const query = (interaction.options.getString('player', true) || '').trim().toLowerCase();
      const core  = await fetchCorePayload();
      const match = (core.roster ?? []).find(p =>
        (p.firstName || p.nameRealm.split('-')[0]).toLowerCase() === query
      );
      if (!match) {
        await interaction.editReply({ content: `No roster player found matching **${interaction.options.getString('player', true)}**.` });
        return;
      }
      const cls   = [match.class, match.spec].filter(Boolean).join(' ');
      const flags = [
        match.isTrial ? 'Trial' : '',
        match.isBench ? 'Bench' : '',
        match.mPlusExcluded ? 'M+ Excluded' : '',
      ].filter(Boolean).join(', ');
      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle(match.nameRealm)
        .addFields(
          { name: 'Class / Spec', value: cls || 'N/A', inline: true },
          { name: 'Role', value: match.role || 'N/A', inline: true },
          { name: 'Attendance', value: match.attendance || 'N/A', inline: true },
          { name: 'Joined', value: match.joinDate ? `${match.joinDate} (${daysAgo(match.joinDate)} ago)` : 'N/A', inline: true },
          ...(flags ? [{ name: 'Status', value: flags, inline: true }] : []),
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /absences ─────────────────────────────────────────────────────────
    if (cmd === 'absences') {
      const core      = await fetchCorePayload();
      const threshold = core.trialAttend ?? 75;
      const below = (core.roster ?? [])
        .filter(p => {
          if (!p.attendance) return false;
          const pct = parseFloat(p.attendance);
          return !isNaN(pct) && pct < threshold;
        })
        .sort((a, b) => parseFloat(a.attendance) - parseFloat(b.attendance));
      if (!below.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('Absences').setDescription(`No players below ${threshold}% attendance.`)] });
        return;
      }
      const lines = below.map(p => {
        const flags = [p.isTrial ? 'Trial' : '', p.isBench ? 'Bench' : ''].filter(Boolean).join(', ');
        return `**${p.nameRealm}** — ${p.attendance}${flags ? ` (${flags})` : ''}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle(`Below ${threshold}% Attendance (${below.length})`)
        .setDescription(truncateLines(lines));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /mplus-excluded ───────────────────────────────────────────────────
    if (cmd === 'mplus-excluded') {
      const core     = await fetchCorePayload();
      const excluded = (core.roster ?? []).filter(p => p.mPlusExcluded);
      if (!excluded.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('M+ Exclusions').setDescription('No players approved for M+ exclusion.')] });
        return;
      }
      const lines = excluded.map(p => {
        const note = p.mPlusNote ? ` — *${p.mPlusNote}*` : '';
        return `**${p.nameRealm}** (${p.class} ${p.spec})${note}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`M+ Excluded (${excluded.length})`)
        .setDescription(truncateLines(lines));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /fairness ─────────────────────────────────────────────────────────
    if (cmd === 'fairness') {
      const heavy  = await fetchHeavyPayload();
      const counts = heavy.lootCounts ?? {};
      const entries = Object.entries(counts)
        .map(([name, lc]) => ({ name, count: lc.count, heroicCount: lc.heroicCount, mythicCount: lc.mythicCount }))
        .sort((a, b) => b.count - a.count);
      if (!entries.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('Loot Fairness').setDescription('No loot data available.')] });
        return;
      }
      const total = entries.reduce((s, e) => s + e.count, 0);
      const avg   = (total / entries.length).toFixed(1);
      const top5  = entries.slice(0, 5).map((e, i) => `${i + 1}. **${e.name}** — ${e.count} (H:${e.heroicCount} M:${e.mythicCount})`);
      const bot5  = entries.slice(-5).reverse().map((e, i) => `${i + 1}. **${e.name}** — ${e.count} (H:${e.heroicCount} M:${e.mythicCount})`);
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle('Loot Fairness')
        .addFields(
          { name: `Most loot (top 5 of ${entries.length})`, value: top5.join('\n') || 'N/A' },
          { name: 'Least loot (bottom 5)', value: bot5.join('\n') || 'N/A' },
          { name: 'Stats', value: `${entries.length} players tracked | ${total} total items | avg ${avg}/player`, inline: false },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /officers ─────────────────────────────────────────────────────────
    if (cmd === 'officers') {
      const core       = await fetchCorePayload();
      const officerIds = core.officerDiscordIds ?? [];
      const claims     = core.discordClaims ?? [];
      if (!officerIds.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('Officers').setDescription('No officers configured.')] });
        return;
      }
      const claimById = new Map(claims.map(c => [c.discordId, c]));
      const lines = officerIds.map(id => {
        const claim = claimById.get(id);
        const username  = claim?.username  ? `@${claim.username}` : `<@${id}>`;
        const character = claim?.nameRealm ? ` — ${claim.nameRealm}` : '';
        return `${username}${character}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x2c3e50)
        .setTitle(`Officers (${officerIds.length})`)
        .setDescription(truncateLines(lines));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await interaction.editReply(`Error: ${msg}`).catch(() => null);
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
