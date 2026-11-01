import "dotenv/config";
import {
  ActionRowBuilder,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  type GuildMember,
  type Message,
} from "discord.js";
import { startAlertPolling } from "./alerts.js";
import { config, PREFIX, validateConfig } from "./config.js";
import { Database, type AlertPlatform, type Giveaway } from "./database.js";
import { getLevelTitle } from "./levelTitles.js";

const missingConfig = validateConfig();
if (missingConfig.length) {
  console.error(`Missing configuration: ${missingConfig.join(", ")}. Copy .env.example to .env and fill in the values.`);
  process.exit(1);
}

const database = new Database(config.tursoUrl, config.tursoAuthToken);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.AutoModerationExecution,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const memberCommands = [
  "level top, rank [@user]",
  "status [@user], setbio <text|clear>",
  "afk [reason], prof [@user], banner [@user], snipe [@user]",
  "daily, rep @user|top, lb rep",
  "birthday set <month> <day>, birthday clear",
  "stats, ping, help",
];
const serverManagementCommands = [
  "welcome #channel | message, welcome off",
  "leave #channel | message, leave off",
  "autorole @role, autorole off",
  "logs #channel, logs off",
  "level enable|disable",
  "level reward <level> @role, level ignore-channel|allow-channel #channel, level ignore-role|allow-role @role",
  "giveaway start <duration> <prize>, giveaway reroll",
  "alerts channel #channel|off, alerts add twitch|youtube|kick <channel>, alerts list|remove <id>",
  "birthday channel #channel|off",
  "automod enable|disable",
];
const roleManagementCommands = [
  "role add @role [button label]",
];
const channelManagementCommands = [
  "ticket setup @support-role",
];
const moderationCommands = [
  "kick @user [reason], ban @user [reason], softban @user [reason]",
  "timeout @user <minutes> [reason], mute @user <minutes> [reason]",
  "warn @user <reason>, warnings @user, clear <1-100>",
  "lock [#channel], unlock [#channel]",
];
const botOwnerCommands = [
  "level max @user",
];
const botOwnerIds = new Set<string>();
let botOwnerLookup: Promise<void> | undefined;

function loadBotOwnerIds(): Promise<void> {
  if (!botOwnerLookup) {
    const applicationClient = client.application;
    if (!applicationClient) return Promise.resolve();
    botOwnerLookup = applicationClient.fetch().then((application) => {
      const owner = application.owner;
      if (!owner) return;
      if ("members" in owner) {
        if (owner.ownerId) botOwnerIds.add(owner.ownerId);
        for (const memberId of owner.members.keys()) botOwnerIds.add(memberId);
      } else {
        botOwnerIds.add(owner.id);
      }
    }).catch((error) => {
      console.error("Could not load bot application owners:", error);
    });
  }
  return botOwnerLookup;
}

async function canManageChannelLock(message: Message): Promise<boolean> {
  await loadBotOwnerIds();
  return botOwnerIds.has(message.author.id)
    || message.guild?.ownerId === message.author.id
    || hasPermission(message, PermissionsBitField.Flags.Administrator);
}

function hasPermission(message: Message, permission: bigint): boolean {
  return Boolean(message.member?.permissions.has(permission));
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const years = Math.floor(totalMinutes / 525_600);
  const months = Math.floor((totalMinutes % 525_600) / 43_800);
  const days = Math.floor((totalMinutes % 43_800) / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    years ? `${years}y` : "",
    months ? `${months}mo` : "",
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
  ].filter(Boolean);
  return parts.slice(0, 2).join(" ") || "less than a minute";
}

const xpCooldowns = new Map<string, number>();
const voiceSessions = new Map<string, number>();
const inviteUses = new Map<string, Map<string, number>>();
type SnipedMessage = {
  authorTag: string;
  authorId: string;
  avatarUrl: string;
  content: string;
  createdAt: number;
  attachments: string[];
};
const snipedMessages = new Map<string, SnipedMessage[]>();

function parseDuration(input: string | undefined): number | undefined {
  const match = input?.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  const duration = amount * multiplier;
  return Number.isSafeInteger(duration) && duration > 0 && duration <= 365 * 86_400_000 ? duration : undefined;
}

function parseBirthdayMonth(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const numeric = Number(input);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const monthIndex = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .findIndex((month) => month.startsWith(input.toLowerCase()));
  return monthIndex < 0 ? undefined : monthIndex + 1;
}

async function cacheGuildInvites(guild: NonNullable<Message["guild"]>): Promise<void> {
  try {
    const invites = await guild.invites.fetch();
    inviteUses.set(guild.id, new Map(invites.map((invite) => [invite.code, invite.uses ?? 0])));
  } catch (error) {
    console.warn(`Invite tracking unavailable in ${guild.name}:`, error);
  }
}

async function findUsedInvite(guild: NonNullable<Message["guild"]>): Promise<{ tag: string; uses: number } | undefined> {
  const previousUses = inviteUses.get(guild.id) ?? new Map<string, number>();
  try {
    const invites = await guild.invites.fetch();
    const usedInvite = invites.find((invite) => (invite.uses ?? 0) > (previousUses.get(invite.code) ?? 0));
    inviteUses.set(guild.id, new Map(invites.map((invite) => [invite.code, invite.uses ?? 0])));
    return usedInvite?.inviter
      ? { tag: usedInvite.inviter.tag, uses: usedInvite.uses ?? 1 }
      : undefined;
  } catch (error) {
    console.warn(`Could not identify invite in ${guild.name}:`, error);
    return undefined;
  }
}

async function sendLog(guildId: string, title: string, description: string): Promise<void> {
  try {
    const settings = await database.getSettings(guildId);
    if (typeof settings.log_channel_id !== "string") return;
    const channel = await client.channels.fetch(settings.log_channel_id).catch(() => null);
    if (channel?.isSendable()) {
      await channel.send({
        embeds: [new EmbedBuilder().setColor(0x687182).setTitle(title).setDescription(description).setTimestamp()],
      });
    }
  } catch (error) {
    console.error("Server log failed:", error);
  }
}

async function resolveMember(message: Message, input: string | undefined): Promise<GuildMember | null> {
  const guild = message.guild;
  if (!guild || !input) return null;
  const mention = message.mentions.members?.first();
  if (mention) return mention;
  const id = input.replace(/[<@!>]/g, "");
  return guild.members.fetch(id).catch(() => null);
}

async function handleCommand(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [command = "", ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  if (!command) return;
  const guildId = message.guild.id;

  try {
    if (command === "daily") {
      const claim = await database.claimDaily(guildId, message.author.id);
      if (!claim.claimed) {
        await message.reply(`Your daily reward is on cooldown. Come back in ${formatDuration(claim.remainingMs)}.`);
        return;
      }
      const baseXp = 50;
      await database.addXp(guildId, message.author.id, baseXp + claim.bonusXp);
      const milestoneText = claim.milestone
        ? ` You hit the ${claim.milestone}-day milestone for an extra **${claim.bonusXp} XP**!`
        : "";
      await message.reply(`Daily reward claimed! Streak: **${claim.streak}** day${claim.streak === 1 ? "" : "s"}. You earned **${baseXp} XP**.${milestoneText}`);
      return;
    }
    const showRepLeaderboard = ((command === "lb" || command === "leaderboard") && args[0]?.toLowerCase() === "rep")
      || (command === "rep" && args[0]?.toLowerCase() === "top");
    if (showRepLeaderboard) {
      const leaders = await database.getReputationLeaderboard(guildId);
      const description = leaders.length
        ? leaders.map((entry, index) => `**${index + 1}.** <@${entry.userId}> - **${entry.points}** rep`).join("\n")
        : "No reputation has been awarded yet.";
      await message.reply({ embeds: [new EmbedBuilder().setColor(0x55c278).setTitle("Most helpful members").setDescription(description)] });
      return;
    }
    if (command === "rep") {
      const target = await resolveMember(message, args[0]);
      if (!target) {
        await message.reply(`Mention a server member. Usage: \`${PREFIX}rep @user\``);
        return;
      }
      if (target.id === message.author.id || target.user.bot) {
        await message.reply("You can give reputation to another human member, not yourself or a bot.");
        return;
      }
      const result = await database.giveReputation(guildId, message.author.id, target.id);
      if (!result.given) {
        await message.reply(`You can give reputation again in ${formatDuration(result.remainingMs)}.`);
        return;
      }
      await message.reply(`${target} received a reputation point from ${message.author}. They now have **${result.points}** rep.`);
      return;
    }
    if (command === "birthday") {
      const action = args[0]?.toLowerCase();
      if (action === "set") {
        const month = parseBirthdayMonth(args[1]);
        const day = Number(args[2]);
        const date = month ? new Date(Date.UTC(2024, month - 1, day)) : undefined;
        if (!month || !Number.isInteger(day) || !date || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
          await message.reply(`Usage: \`${PREFIX}birthday set <month> <day>\` (example: \`${PREFIX}birthday set March 14\`).`);
          return;
        }
        await database.setBirthday(guildId, message.author.id, month, day);
        await message.reply(`Your birthday is saved as **${new Date(Date.UTC(2024, month - 1, day)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}**.`);
        return;
      }
      if (action === "clear") {
        await database.removeBirthday(guildId, message.author.id);
        await message.reply("Your saved birthday was removed.");
        return;
      }
      if (action === "channel") {
        if (!hasPermission(message, PermissionsBitField.Flags.ManageGuild)) {
          await message.reply("You need **Manage Server** to configure the birthday channel.");
          return;
        }
        if (args[1]?.toLowerCase() === "off") {
          await database.setSetting(guildId, "birthday_channel_id", null);
          await message.reply("Birthday announcements are disabled.");
          return;
        }
        const channel = message.mentions.channels.first();
        if (!channel?.isTextBased()) {
          await message.reply(`Usage: \`${PREFIX}birthday channel #channel\` or \`${PREFIX}birthday channel off\``);
          return;
        }
        await database.setSetting(guildId, "birthday_channel_id", channel.id);
        await message.reply(`Birthday announcements will be posted in ${channel} at midnight UTC.`);
        return;
      }
      await message.reply(`Usage: \`${PREFIX}birthday set <month> <day>\`, \`${PREFIX}birthday clear\`, or \`${PREFIX}birthday channel #channel|off\`.`);
      return;
    }
    if (command === "help") {
      await loadBotOwnerIds();
      const canSeeAdminCommands = botOwnerIds.has(message.author.id)
        || message.guild.ownerId === message.author.id
        || hasPermission(message, PermissionsBitField.Flags.Administrator);
      const sections = [{
        name: "Member commands",
        value: memberCommands.map((entry) => `\`${PREFIX}${entry}\``).join("\n"),
      }];
      if (canSeeAdminCommands) {
        sections.push({
          name: "Server management commands",
          value: serverManagementCommands.map((entry) => `\`${PREFIX}${entry}\``).join("\n"),
        });
        sections.push({
          name: "Role management commands",
          value: roleManagementCommands.map((entry) => `\`${PREFIX}${entry}\``).join("\n"),
        });
        sections.push({
          name: "Channel management commands",
          value: channelManagementCommands.map((entry) => `\`${PREFIX}${entry}\``).join("\n"),
        });
        sections.push({
          name: "Moderation commands",
          value: moderationCommands.map((entry) => `\`${PREFIX}${entry}\``).join("\n"),
        });
      }
      if (botOwnerIds.has(message.author.id)) {
        sections.push({
          name: "Bot owner commands",
          value: botOwnerCommands.map((entry) => `\`${PREFIX}${entry}\``).join("\n"),
        });
      }
      const embed = new EmbedBuilder()
        .setColor(0x55c278)
        .setTitle("Valkyr commands")
        .addFields(sections);
      await message.reply({ embeds: [embed] });
      return;
    }
    if (command === "ping") {
      await message.reply(`Pong! ${client.ws.ping} ms`);
      return;
    }
    if (command === "stats") {
      const guild = message.guild;
      const [members, channels, roles] = await Promise.all([
        guild.members.fetch().then((items) => items.size).catch(() => guild.memberCount),
        guild.channels.fetch().then((items) => items.size),
        guild.roles.fetch().then((items) => items.size),
      ]);
      const activity = await database.getActivitySummary(guild.id);
      const highestDailyCount = Math.max(1, ...activity.dailyMessages.map((entry) => entry.messages));
      const messageChart = activity.dailyMessages.length
        ? activity.dailyMessages.map((entry) => {
          const bar = "#".repeat(Math.max(1, Math.round(entry.messages / highestDailyCount * 18)));
          return `\`${entry.day.slice(5)}\` ${bar} ${entry.messages}`;
        }).join("\n")
        : "No messages recorded yet.";
      const topMembers = activity.topMembers.length
        ? activity.topMembers.map((entry, index) => `**${index + 1}.** <@${entry.userId}> - ${entry.messages}`).join("\n")
        : "No activity recorded yet.";
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x55c278).setTitle(`${guild.name} server stats`)
          .setDescription(`**Messages by day (last 7 days)**\n${messageChart}`)
          .addFields(
          { name: "Members", value: String(members), inline: true },
          { name: "Channels", value: String(channels), inline: true },
          { name: "Roles", value: String(roles), inline: true },
          { name: "Messages (30 days)", value: String(activity.messages), inline: true },
          { name: "Joins / leaves (30 days)", value: `${activity.joins} / ${activity.leaves}`, inline: true },
          { name: "Voice hours (30 days)", value: (activity.voiceMinutes / 60).toFixed(1), inline: true },
          { name: "Most active members (30 days)", value: topMembers },
        )],
      });
      return;
    }
    if (command === "rank") {
      const target = message.mentions.users.first() ?? message.author;
      const xp = await database.getXp(guildId, target.id);
      const level = Math.floor(Math.sqrt(xp / 100));
      const title = getLevelTitle(level);
      const currentLevelXp = level * level * 100;
      const nextLevelXp = (level + 1) * (level + 1) * 100;
      const progress = xp - currentLevelXp;
      const required = nextLevelXp - currentLevelXp;
      const filled = Math.min(10, Math.floor(progress / required * 10));
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x55c278).setTitle(`${target.username}'s rank`)
          .setDescription(`Level **${level} · ${title.emoji} ${title.name}**\n${"#".repeat(filled)}${"-".repeat(10 - filled)} ${progress}/${required} XP`)
          .setThumbnail(target.displayAvatarURL())],
      });
      return;
    }
    if (command === "status") {
      const user = message.mentions.users.first() ?? message.author;
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await message.reply("That user is not a member of this server.");
        return;
      }
      const metrics = await database.getMemberMetrics(guildId, user.id);
      const xp = await database.getXp(guildId, user.id);
      const level = Math.floor(Math.sqrt(xp / 100));
      const title = getLevelTitle(level);
      const accountAge = formatDuration(Date.now() - user.createdTimestamp);
      const serverTime = member.joinedTimestamp
        ? formatDuration(Date.now() - member.joinedTimestamp)
        : "Unknown";
      await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x55c278)
          .setTitle(`${member.displayName}'s status`)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: "User Profile", value: `Member: ${member}\nAccount age: ${accountAge}\nOn this server: ${serverTime}` },
            { name: "Personal Bio", value: metrics.bio ?? "No bio set. Use `,setbio <text>` to add one." },
            { name: "Level", value: `**${level} · ${title.emoji} ${title.name}** (${xp.toLocaleString()} XP)`, inline: true },
            { name: "Server Statistics", value: `Words sent: **${metrics.wordsSent.toLocaleString()}**\nCommands used: **${metrics.commandsUsed.toLocaleString()}**\nEstimated voice time: **${formatDuration(metrics.voiceMinutes * 60_000)}**` },
          )],
      });
      return;
    }
    if (command === "setbio") {
      const bioText = args.join(" ").trim();
      const bio = bioText && bioText.toLowerCase() !== "clear" ? bioText.slice(0, 300) : null;
      await database.setMemberBio(guildId, message.author.id, bio);
      await message.reply(bio
        ? `Your profile bio has been updated (${bio.length}/300 characters). It will appear on your \`,status\` card.`
        : "Your profile bio has been cleared.");
      return;
    }
    if (command === "afk") {
      const reason = args.join(" ").trim().slice(0, 400) || "AFK";
      await database.setAfk(guildId, message.author.id, reason);
      await message.reply(`You're now AFK: ${reason}`);
      return;
    }
    if (command === "prof") {
      const user = message.mentions.users.first() ?? message.author;
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await message.reply("That user is not a member of this server.");
        return;
      }
      const roles = member.roles.cache.filter((role) => role.id !== guildId).map((role) => role.toString()).slice(0, 8);
      const embed = new EmbedBuilder()
        .setColor(0x55c278)
        .setAuthor({ name: `${user.tag} profile`, iconURL: user.displayAvatarURL() })
        .setTitle(member.displayName)
        .setImage(user.displayAvatarURL({ size: 1024 }))
        .addFields(
          { name: "Account created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: true },
          { name: "Joined server", value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Unknown", inline: true },
          { name: "User ID", value: user.id, inline: true },
          { name: "Roles", value: roles.join(", ") || "No roles", inline: false },
        );
      await message.reply({ embeds: [embed] });
      return;
    }
    if (command === "banner") {
      const target = message.mentions.users.first() ?? message.author;
      const user = await client.users.fetch(target.id, { force: true });
      const bannerUrl = user.bannerURL({ size: 1024 });
      if (!bannerUrl) {
        await message.reply(`${user.tag} does not have a Discord profile banner.`);
        return;
      }
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x55c278).setTitle(`${user.tag}'s banner`).setImage(bannerUrl)],
      });
      return;
    }
    if (command === "snipe") {
      const target = message.mentions.users.first();
      const recentMessages = snipedMessages.get(message.channelId) ?? [];
      const deleted = target
        ? recentMessages.find((entry) => entry.authorId === target.id)
        : recentMessages[0];
      if (!deleted) {
        await message.reply(target
          ? `I haven't cached a recently deleted message from ${target} in this channel.`
          : "There is no recently deleted message to snipe in this channel.");
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0x687182)
        .setAuthor({ name: deleted.authorTag, iconURL: deleted.avatarUrl })
        .setDescription(deleted.content.slice(0, 3900) || "*(No text content)*")
        .setFooter({ text: `Deleted message from ${deleted.authorId}` })
        .setTimestamp(deleted.createdAt);
      if (deleted.attachments.length) {
        embed.addFields({ name: "Attachments", value: deleted.attachments.slice(0, 5).join("\n").slice(0, 1000) });
        if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(deleted.attachments[0] ?? "")) embed.setImage(deleted.attachments[0]!);
      }
      await message.reply({ embeds: [embed] });
      return;
    }
    if (command === "giveaway") {
      const action = args[0]?.toLowerCase();
      if (!hasPermission(message, PermissionsBitField.Flags.ManageGuild)) {
        await message.reply("You need **Manage Server** to manage giveaways.");
        return;
      }
      if (action === "start") {
        const duration = parseDuration(args[1]);
        const prize = args.slice(2).join(" ").trim();
        if (!duration || !prize) {
          await message.reply(`Usage: \`${PREFIX}giveaway start <30s|10m|2h|1d> <prize>\``);
          return;
        }
        if (!message.channel.isSendable()) return;
        const endsAt = Date.now() + duration;
        const button = new ButtonBuilder()
          .setCustomId("giveaway:enter")
          .setLabel("Enter Giveaway")
          .setEmoji("🤙")
          .setStyle(ButtonStyle.Success);
        const giveawayMessage = await message.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0x55c278)
            .setTitle("Giveaway")
            .setDescription(`Prize: **${prize.slice(0, 500)}**\nHost: ${message.author}\nClick the button below to enter.`)
            .setFooter({ text: "Entries close" })
            .setTimestamp(endsAt)],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        });
        await database.createGiveaway({
          messageId: giveawayMessage.id,
          guildId,
          channelId: message.channelId,
          hostId: message.author.id,
          prize: prize.slice(0, 500),
          endsAt,
        });
        await message.reply(`Giveaway started for **${prize.slice(0, 500)}**.`);
        return;
      }
      if (action === "reroll") {
        const giveaway = await database.getLatestEndedGiveaway(message.channelId);
        if (!giveaway) {
          await message.reply("There is no completed giveaway in this channel to reroll.");
          return;
        }
        const entries = await database.getGiveawayEntries(giveaway.messageId);
        const eligible = entries.filter((userId) => !giveaway.winnerIds.includes(userId));
        const winnerId = eligible[Math.floor(Math.random() * eligible.length)];
        if (!winnerId) {
          await message.reply("There are no unselected entrants left to reroll.");
          return;
        }
        await database.updateGiveawayWinners(giveaway.messageId, [...giveaway.winnerIds, winnerId]);
        await message.reply(`New winner for **${giveaway.prize}**: <@${winnerId}>!`);
        return;
      }
      await message.reply(`Usage: \`${PREFIX}giveaway start <duration> <prize>\` or \`${PREFIX}giveaway reroll\``);
      return;
    }

    if (["welcome", "leave", "autorole", "logs", "level", "alerts", "automod"].includes(command)) {
      const publicLevelCommand = command === "level" && args[0]?.toLowerCase() === "top";
      const botOwnerLevelCommand = command === "level" && args[0]?.toLowerCase() === "max";
      if (botOwnerLevelCommand) await loadBotOwnerIds();
      const canSetMaxLevel = botOwnerLevelCommand && botOwnerIds.has(message.author.id);
      if (!publicLevelCommand && !canSetMaxLevel && !hasPermission(message, PermissionsBitField.Flags.ManageGuild)) {
        await message.reply("You need **Manage Server** to change bot settings.");
        return;
      }
      if (command === "welcome") {
        if (args[0]?.toLowerCase() === "off") {
          await database.setSetting(guildId, "welcome_channel_id", null);
          await message.reply("Welcome messages are disabled.");
          return;
        }
        const channel = message.mentions.channels.first();
        if (!channel || !channel.isTextBased()) {
          await message.reply(`Usage: \`${PREFIX}welcome #channel | Welcome {user} to {server}!\` or \`${PREFIX}welcome off\``);
          return;
        }
        const input = args.join(" ");
        const welcomeText = input.includes("|") ? input.slice(input.indexOf("|") + 1).trim() : "Welcome {user} to {server}!";
        await database.setSetting(guildId, "welcome_channel_id", channel.id);
        await database.setSetting(guildId, "welcome_message", welcomeText || "Welcome {user} to {server}!");
        await message.reply(`Welcome messages will be sent to ${channel}. Use \`{user}\` and \`{server}\` in the message.`);
        return;
      }
      if (command === "leave") {
        if (args[0]?.toLowerCase() === "off") {
          await database.setSetting(guildId, "leave_channel_id", null);
          await message.reply("Leave messages are disabled.");
          return;
        }
        const channel = message.mentions.channels.first();
        if (!channel?.isTextBased()) {
          await message.reply(`Usage: \`${PREFIX}leave #channel | See ya! {user} Thankyou for memories. GOODBYE\` or \`${PREFIX}leave off\``);
          return;
        }
        const input = args.join(" ");
        const leaveText = input.includes("|")
          ? input.slice(input.indexOf("|") + 1).trim()
          : "See ya! {user} Thankyou for memories. GOODBYE";
        await database.setSetting(guildId, "leave_channel_id", channel.id);
        await database.setSetting(guildId, "leave_message", leaveText || "See ya! {user} Thankyou for memories. GOODBYE");
        await message.reply(`Leave embeds will be sent to ${channel}. Use \`{user}\` and \`{server}\` in the caption.`);
        return;
      }
      if (command === "autorole") {
        if (args[0]?.toLowerCase() === "off") {
          await database.setSetting(guildId, "autorole_id", null);
          await message.reply("Autorole is disabled.");
          return;
        }
        const role = message.mentions.roles.first();
        if (!role) {
          await message.reply(`Usage: \`${PREFIX}autorole @role\` or \`${PREFIX}autorole off\``);
          return;
        }
        await database.setSetting(guildId, "autorole_id", role.id);
        await message.reply(`New members will receive ${role}.`);
        return;
      }
      if (command === "logs") {
        if (args[0]?.toLowerCase() === "off") {
          await database.setSetting(guildId, "log_channel_id", null);
          await message.reply("Server logs are disabled.");
          return;
        }
        const channel = message.mentions.channels.first();
        if (!channel?.isTextBased()) {
          await message.reply(`Usage: \`${PREFIX}logs #channel\` or \`${PREFIX}logs off\``);
          return;
        }
        await database.setSetting(guildId, "log_channel_id", channel.id);
        await message.reply(`Server logs will be sent to ${channel}.`);
        return;
      }
      if (command === "level") {
        const action = args[0]?.toLowerCase();
        if (action === "max") {
          if (!botOwnerIds.has(message.author.id)) {
            await message.reply("Only the bot owner can use `,level max`.");
            return;
          }
          const target = await resolveMember(message, args[1]);
          if (!target) {
            await message.reply(`Usage: \`${PREFIX}level max @user\``);
            return;
          }
          await database.setXp(guildId, target.id, 1_000_000);
          await message.reply(`${target} was set to level 100.`);
          return;
        }
        if (action === "top") {
          const leaderboard = await database.getLeaderboard(guildId);
          await message.reply({
            embeds: [new EmbedBuilder().setColor(0x55c278).setTitle("Level leaderboard").setDescription(
              leaderboard.length
                ? leaderboard.map((item, index) => `**${index + 1}.** <@${item.userId}> - ${item.xp} XP (level ${Math.floor(Math.sqrt(item.xp / 100))})`).join("\n")
                : "No XP has been earned yet.",
            )],
          });
          return;
        }
        if (action === "enable" || action === "disable") {
          await database.setSetting(guildId, "leveling_enabled", action === "enable" ? 1 : 0);
          await message.reply(`Leveling ${action === "enable" ? "enabled" : "disabled"}.`);
          return;
        }
        if (action === "reward") {
          const level = Number(args[1]);
          const role = message.mentions.roles.first();
          if (!Number.isInteger(level) || level < 1 || level > 100_000 || !role) {
            await message.reply(`Usage: \`${PREFIX}level reward <level> @role\``);
            return;
          }
          await database.setLevelReward(guildId, level, role.id);
          await message.reply(`${role} is now awarded at level ${level}.`);
          return;
        }
        const [operation, targetType] = action?.split("-") ?? [];
        if ((operation === "ignore" || operation === "allow") && (targetType === "channel" || targetType === "role")) {
          const targetId = targetType === "channel"
            ? message.mentions.channels.first()?.id
            : message.mentions.roles.first()?.id;
          if (!targetId) {
            await message.reply(`Usage: \`${PREFIX}level ${operation}-${targetType} ${targetType === "channel" ? "#channel" : "@role"}\``);
            return;
          }
          await database.setLevelExclusion(guildId, targetType, targetId, operation === "ignore");
          await message.reply(`${targetType === "channel" ? `<#${targetId}>` : `<@&${targetId}>`} ${operation === "ignore" ? "will not earn XP" : "can earn XP again"}.`);
          return;
        }
        await message.reply(`Usage: \`${PREFIX}level enable|disable|top\``);
        return;
      }
      if (command === "alerts") {
        const action = args[0]?.toLowerCase();
        if (action === "channel") {
          if (args[1]?.toLowerCase() === "off") {
            await database.setSetting(guildId, "alerts_channel_id", null);
            await message.reply("Stream and video alerts are disabled.");
            return;
          }
          const channel = message.mentions.channels.first();
          if (!channel?.isTextBased()) {
            await message.reply(`Usage: \`${PREFIX}alerts channel #channel|off\``);
            return;
          }
          await database.setSetting(guildId, "alerts_channel_id", channel.id);
          await message.reply(`Alerts will be posted in ${channel}.`);
          return;
        }
        if (action === "add") {
          const platform = args[1]?.toLowerCase();
          const sourceKey = args[2]?.replace(/^@/, "");
          if (!(platform === "twitch" || platform === "youtube" || platform === "kick") || !sourceKey) {
            await message.reply(`Usage: \`${PREFIX}alerts add twitch|youtube|kick <channel name or YouTube channel ID>\``);
            return;
          }
          await database.addAlert(guildId, platform as AlertPlatform, sourceKey);
          await message.reply(`Added ${platform} alert source \`${sourceKey}\`. Use a YouTube channel ID (starts with UC) for YouTube.`);
          return;
        }
        if (action === "list") {
          const sources = await database.getAlerts(guildId);
          await message.reply(sources.length
            ? sources.map((source) => `**${source.id}.** ${source.platform}: \`${source.source_key}\``).join("\n")
            : "No alert sources are configured.");
          return;
        }
        if (action === "remove") {
          const id = Number(args[1]);
          if (!Number.isInteger(id) || id < 1) {
            await message.reply(`Usage: \`${PREFIX}alerts remove <id>\``);
            return;
          }
          await database.removeAlert(guildId, id);
          await message.reply(`Removed alert source ${id}, if it existed.`);
          return;
        }
        await message.reply(`Usage: \`${PREFIX}alerts channel|add|list|remove ...\``);
        return;
      }
      if (command === "automod") {
        const action = args[0]?.toLowerCase();
        if (action !== "enable" && action !== "disable") {
          await message.reply(`Usage: \`${PREFIX}automod enable|disable\``);
          return;
        }
        const rules = await message.guild.autoModerationRules.fetch();
        let spamRule = rules.find((rule) => rule.name === "Valkyr Spam Filter");
        if (action === "enable") {
          if (spamRule) {
            if (!spamRule.enabled) spamRule = await spamRule.edit({ enabled: true });
          } else if (!rules.some((rule) => rule.triggerType === AutoModerationRuleTriggerType.Spam)) {
            spamRule = await message.guild.autoModerationRules.create({
              name: "Valkyr Spam Filter",
              eventType: AutoModerationRuleEventType.MessageSend,
              triggerType: AutoModerationRuleTriggerType.Spam,
              actions: [{ type: AutoModerationActionType.BlockMessage }],
              reason: "Enable Valkyr's Discord spam and scam protection",
            });
          }
          await database.setSetting(guildId, "automod_enabled", 1);
          await message.reply("AutoMod enabled. Discord's spam filter is active where available; attachments and polls are blocked for non-moderators.");
          return;
        }
        if (spamRule?.enabled) await spamRule.edit({ enabled: false });
        await database.setSetting(guildId, "automod_enabled", 0);
        await message.reply("Valkyr AutoMod is disabled.");
        return;
      }
      return;
    }

    if (["warn", "warnings", "kick", "ban", "softban", "timeout", "mute"].includes(command)) {
      const requiredPermission = command === "kick"
        ? PermissionsBitField.Flags.KickMembers
        : command === "ban" || command === "softban"
          ? PermissionsBitField.Flags.BanMembers
          : PermissionsBitField.Flags.ModerateMembers;
      if (!hasPermission(message, requiredPermission)) {
        await message.reply("You need a moderation permission to use this command.");
        return;
      }
      const target = await resolveMember(message, args[0]);
      if (!target) {
        await message.reply(`Mention a valid server member. Usage: \`${PREFIX}${command} @user${command === "timeout" || command === "mute" ? " <minutes>" : " [reason]"}\``);
        return;
      }
      if (command === "warnings") {
        const warnings = await database.getWarnings(guildId, target.id);
        await message.reply(warnings.length ? warnings.map((warning, index) => `**${index + 1}.** ${warning}`).join("\n") : `${target.user.tag} has no warnings.`);
        return;
      }
      const reasonStart = command === "timeout" || command === "mute" ? 2 : 1;
      const reason = args.slice(reasonStart).join(" ") || "No reason provided";
      if (command === "warn") {
        await database.addWarning(guildId, target.id, message.author.id, reason);
        await message.reply(`Warned ${target.user.tag}: ${reason}`);
        await sendLog(guildId, "Member warned", `${target} was warned by ${message.author}. Reason: ${reason}`);
        return;
      }
      if (command === "kick") {
        await target.kick(reason);
        await message.reply(`Kicked ${target.user.tag}. Reason: ${reason}`);
        await sendLog(guildId, "Member kicked", `${target.user.tag} was kicked by ${message.author}. Reason: ${reason}`);
        return;
      }
      if (command === "ban") {
        await message.guild!.members.ban(target.id, { reason });
        await message.reply(`Banned ${target.user.tag}. Reason: ${reason}`);
        await sendLog(guildId, "Member banned", `${target.user.tag} was banned by ${message.author}. Reason: ${reason}`);
        return;
      }
      if (command === "softban") {
        await message.guild!.members.ban(target.id, { reason, deleteMessageSeconds: 86_400 });
        await message.guild!.members.unban(target.id, `Softban by ${message.author.tag}: ${reason}`);
        await message.reply(`Softbanned ${target.user.tag}. Reason: ${reason}`);
        await sendLog(guildId, "Member softbanned", `${target.user.tag} was softbanned by ${message.author}. Reason: ${reason}`);
        return;
      }
      if (command === "timeout" || command === "mute") {
        const minutes = Number(args[1]);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 40_320) {
          await message.reply("Timeout duration must be from 1 minute to 28 days.");
          return;
        }
        await target.timeout(minutes * 60_000, reason);
        await message.reply(`Timed out ${target.user.tag} for ${minutes} minutes. Reason: ${reason}`);
        await sendLog(guildId, "Member timed out", `${target} was timed out by ${message.author} for ${minutes} minutes. Reason: ${reason}`);
      }
      return;
    }

    if (command === "lock" || command === "unlock") {
      if (!(await canManageChannelLock(message))) {
        await message.reply("Only the bot owner, server owner, or a server administrator can lock channels.");
        return;
      }
      const channel = message.mentions.channels.first() ?? message.channel;
      if (!channel.isTextBased() || !("permissionOverwrites" in channel)) {
        await message.reply(`Usage: \`${PREFIX}${command} [#text-channel]\``);
        return;
      }
      await channel.permissionOverwrites.edit(message.guild!.roles.everyone, {
        SendMessages: command === "lock" ? false : null,
      });
      await message.reply(`${channel} is ${command === "lock" ? "locked" : "unlocked"}.`);
      await sendLog(guildId, `Channel ${command}ed`, `${channel} was ${command}ed by ${message.author}.`);
      return;
    }

    if (command === "clear") {
      if (!hasPermission(message, PermissionsBitField.Flags.ManageMessages)) {
        await message.reply("You need **Manage Messages** permission.");
        return;
      }
      const count = Number(args[0]);
      if (!Number.isInteger(count) || count < 1 || count > 100 || !message.channel.isSendable() || !("bulkDelete" in message.channel)) {
        await message.reply(`Usage: \`${PREFIX}clear <1-100>\``);
        return;
      }
      const deleted = await message.channel.bulkDelete(count + 1, true);
      const confirmation = await message.channel.send(`Deleted ${Math.max(0, deleted.size - 1)} messages.`);
      setTimeout(() => void confirmation.delete().catch(() => undefined), 4_000);
      await sendLog(guildId, "Messages cleared", `${message.author} cleared ${Math.max(0, deleted.size - 1)} messages in <#${message.channelId}>.`);
      return;
    }

    if (command === "role") {
      if (!hasPermission(message, PermissionsBitField.Flags.ManageRoles)) {
        await message.reply("You need **Manage Roles** permission.");
        return;
      }
      const role = message.mentions.roles.first();
      if (args[0]?.toLowerCase() !== "add" || !role) {
        await message.reply(`Usage: \`${PREFIX}role add @role [button label]\``);
        return;
      }
      const label = args.slice(2).join(" ").slice(0, 80) || role.name;
      const button = new ButtonBuilder().setCustomId(`role-toggle:${role.id}`).setLabel(label).setStyle(ButtonStyle.Secondary);
      if (!message.channel.isSendable()) return;
      await message.channel.send({
        embeds: [new EmbedBuilder().setColor(0x55c278).setTitle("Choose your role").setDescription(`Press the button to toggle **${role.name}**.`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      });
      return;
    }

    if (command === "ticket") {
      if (args[0]?.toLowerCase() !== "setup" || !hasPermission(message, PermissionsBitField.Flags.ManageChannels)) {
        await message.reply(`Usage: \`${PREFIX}ticket setup @support-role\` (requires **Manage Channels**).`);
        return;
      }
      const button = new ButtonBuilder().setCustomId("ticket:create").setLabel("Create a ticket").setStyle(ButtonStyle.Success);
      const supportRole = message.mentions.roles.first();
      if (!supportRole) {
        await message.reply(`Mention the role that should see tickets: \`${PREFIX}ticket setup @support-role\``);
        return;
      }
      await database.setSetting(guildId, "ticket_support_role_id", supportRole.id);
      if (!message.channel.isSendable()) return;
      await message.channel.send({
        embeds: [new EmbedBuilder().setColor(0x55c278).setTitle("Support tickets").setDescription(`Press the button to open a private support channel. ${supportRole} will be notified.`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      });
      return;
    }

    await message.reply(`Unknown command. Use \`${PREFIX}help\` to see commands.`);
  } catch (error) {
    console.error(`Command failed (${command}):`, error);
    await message.reply("That action failed. Check my permissions, role position, and the command arguments.").catch(() => undefined);
  }
}

async function concludeGiveaway(giveaway: Giveaway): Promise<void> {
  if (giveaway.status !== "active") return;
  const entries = await database.getGiveawayEntries(giveaway.messageId);
  const winnerId = entries[Math.floor(Math.random() * entries.length)];
  const winners = winnerId ? [winnerId] : [];
  if (!(await database.finishGiveaway(giveaway.messageId, winners))) return;

  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.isSendable()) return;
  const embed = new EmbedBuilder()
    .setColor(0x687182)
    .setTitle("Giveaway ended")
    .setDescription(winnerId ? `Prize: **${giveaway.prize}**\nWinner: <@${winnerId}>` : `Prize: **${giveaway.prize}**\nNo one entered.`)
    .setTimestamp();
  const disabledButton = new ButtonBuilder()
    .setCustomId("giveaway:enter")
    .setLabel("Giveaway ended")
    .setEmoji("🤙")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  if (channel.isTextBased() && "messages" in channel) {
    const giveawayMessage = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (giveawayMessage) {
      await giveawayMessage.edit({
        embeds: [embed],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton)],
      }).catch((error) => console.error("Could not update giveaway message:", error));
    }
  }
  await channel.send(winnerId ? `Giveaway winner: <@${winnerId}>!` : `Giveaway for **${giveaway.prize}** ended with no entries.`);
}

function startGiveawayExpiration(): void {
  const poll = async (): Promise<void> => {
    try {
      const dueGiveaways = await database.getDueGiveaways(Date.now());
      for (const giveaway of dueGiveaways) await concludeGiveaway(giveaway);
    } catch (error) {
      console.error("Giveaway expiration check failed:", error);
    }
  };
  void poll();
  setInterval(() => void poll(), 15_000);
}

function startBirthdayScheduler(): void {
  let lastRunDate = "";
  let running = false;
  const checkBirthdays = async (): Promise<void> => {
    const now = new Date();
    if (now.getUTCHours() !== 0 || running) return;
    const year = now.getUTCFullYear();
    const dateKey = `${year}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
    if (lastRunDate === dateKey) return;
    running = true;
    try {
      const birthdays = await database.getBirthdays(now.getUTCMonth() + 1, now.getUTCDate());
      for (const birthday of birthdays) {
        if (await database.hasBirthdayAnnouncement(birthday.guildId, birthday.userId, year)) continue;
        const settings = await database.getSettings(birthday.guildId);
        if (typeof settings.birthday_channel_id !== "string") continue;
        const channel = await client.channels.fetch(settings.birthday_channel_id).catch(() => null);
        if (!channel?.isSendable()) continue;
        const guild = client.guilds.cache.get(birthday.guildId);
        const member = await guild?.members.fetch(birthday.userId).catch(() => null);
        if (!member) continue;
        const embed = new EmbedBuilder()
          .setColor(0xffbf69)
          .setTitle(`HAPPY BIRTHDAY, ${member.displayName}!`)
          .setDescription(`Everyone wish ${member} a wonderful birthday!`)
          .setThumbnail(member.displayAvatarURL({ size: 256 }))
          .setImage(config.birthdayGifUrl)
          .setTimestamp();
        await channel.send({ content: `Happy birthday, ${member}!`, embeds: [embed] });
        await database.markBirthdayAnnounced(birthday.guildId, birthday.userId, year);
      }
      lastRunDate = dateKey;
    } catch (error) {
      console.error("Birthday announcement check failed:", error);
    } finally {
      running = false;
    }
  };
  void checkBirthdays();
  setInterval(() => void checkBirthdays(), 60_000);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}; prefix is ${PREFIX}`);
  await loadBotOwnerIds();
  await Promise.all(client.guilds.cache.map((guild) => cacheGuildInvites(guild)));
  startAlertPolling(client, database);
  startGiveawayExpiration();
  startBirthdayScheduler();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.guild && !message.author.bot) {
    const commandName = message.content.startsWith(PREFIX)
      ? message.content.slice(PREFIX.length).trim().split(/\s+/)[0]?.toLowerCase()
      : undefined;
    if (commandName !== "afk") {
      const ownAfk = await database.getAfk(message.guild.id, message.author.id).catch(() => undefined);
      if (ownAfk) {
        await database.removeAfk(message.guild.id, message.author.id).catch((error) => console.error("AFK clear failed:", error));
        await message.reply(`Welcome back, ${message.author}. You were away for ${formatDuration(Date.now() - ownAfk.startedAt)}.`).catch(() => undefined);
      }
      const mentionedIds = [...message.mentions.users.keys()].filter((userId) => userId !== message.author.id);
      if (mentionedIds.length) {
        const awayUsers = await database.getAfkStatuses(message.guild.id, mentionedIds).catch(() => []);
        if (awayUsers.length) {
          const notice = awayUsers.slice(0, 5).map((away) =>
            `<@${away.userId}> is AFK: ${away.reason} (away for ${formatDuration(Date.now() - away.startedAt)})`,
          ).join("\n");
          await message.reply({ content: notice, allowedMentions: { parse: [] } }).catch(() => undefined);
        }
      }
    }
    const settings = await database.getSettings(message.guild.id).catch(() => null);
    const isModerator = Boolean(message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages));
    if (settings?.automod_enabled && !isModerator && (message.attachments.size > 0 || message.poll)) {
      await message.delete().catch(() => undefined);
      await sendLog(message.guild.id, "AutoMod blocked content", `Blocked an attachment or poll from ${message.author} in <#${message.channelId}>.`);
      return;
    }
    const isCommand = message.content.startsWith(PREFIX) && message.content.slice(PREFIX.length).trim().length > 0;
    const wordCount = isCommand ? 0 : message.content.trim().split(/\s+/).filter(Boolean).length;
    await database.recordMessage(message.guild.id, message.author.id, wordCount, isCommand).catch((error) => console.error("Activity tracking failed:", error));
    if (!message.content.startsWith(PREFIX) && settings?.leveling_enabled && message.member) {
      const levelExcluded = await database.isLevelExcluded(message.guild.id, message.channelId, [...message.member.roles.cache.keys()]).catch(() => false);
      if (!levelExcluded) {
        const now = Date.now();
        const cooldownKey = `${message.guild.id}:${message.author.id}`;
        const lastMessageAt = xpCooldowns.get(cooldownKey) ?? 0;
        if (now - lastMessageAt >= 60_000) {
          if (xpCooldowns.size > 10_000) {
            for (const [key, timestamp] of xpCooldowns) {
              if (now - timestamp >= 60_000) xpCooldowns.delete(key);
            }
          }
          xpCooldowns.set(cooldownKey, now);
          const amount = 5 + Math.floor(Math.random() * 11);
          const xp = await database.addXp(message.guild.id, message.author.id, amount).catch(() => 0);
          const previousLevel = Math.floor(Math.sqrt(Math.max(0, xp - amount) / 100));
          const currentLevel = Math.floor(Math.sqrt(xp / 100));
          if (currentLevel > previousLevel) {
            const rewardId = await database.getLevelReward(message.guild.id, currentLevel).catch(() => undefined);
            const rewardRole = rewardId ? await message.guild.roles.fetch(rewardId).catch(() => null) : null;
            if (rewardRole && message.member) await message.member.roles.add(rewardRole).catch((error) => console.error("Level reward failed:", error));
            await message.reply(`Level up! You reached level ${currentLevel}.${rewardRole ? ` You earned **${rewardRole.name}**.` : ""}`).catch(() => undefined);
          }
        }
      }
    }
  }
  await handleCommand(message);
});

client.on(Events.GuildMemberAdd, async (member) => {
  await database.recordMemberChange(member.guild.id, "joins").catch((error) => console.error("Join tracking failed:", error));
  const settings = await database.getSettings(member.guild.id);
  const inviter = await findUsedInvite(member.guild);
  if (typeof settings.autorole_id === "string") {
    const role = await member.guild.roles.fetch(settings.autorole_id).catch(() => null);
    if (role) await member.roles.add(role).catch((error) => console.error("Autorole failed:", error));
  }
  if (typeof settings.welcome_channel_id === "string") {
    const channel = await client.channels.fetch(settings.welcome_channel_id).catch(() => null);
    if (channel?.isSendable()) {
      const template = typeof settings.welcome_message === "string" ? settings.welcome_message : "Welcome {user} to {server}!";
      const greeting = template.replaceAll("{user}", `${member}`).replaceAll("{server}", member.guild.name).slice(0, 256);
      const accountAge = formatDuration(Date.now() - member.user.createdTimestamp);
      const totalMembers = member.guild.memberCount;
      const embed = new EmbedBuilder()
        .setColor(0x55c278)
        .setTitle(greeting)
        .setThumbnail(member.displayAvatarURL({ size: 512 }))
        .addFields(
          { name: "User Profile", value: `Mention: ${member}\nAccount age: ${accountAge}\nInvited by: ${inviter ? `@${inviter.tag} (${inviter.uses} invites)` : "Unknown"}` },
          { name: "Server Statistics", value: `Position: #${totalMembers}\nTotal members: ${totalMembers}` },
        )
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  }
  await sendLog(member.guild.id, "Member joined", `${member.user.tag} joined the server.`);
});

client.on(Events.GuildMemberRemove, async (member) => {
  void database.recordMemberChange(member.guild.id, "leaves").catch((error) => console.error("Leave tracking failed:", error));
  const settings = await database.getSettings(member.guild.id).catch(() => null);
  if (typeof settings?.leave_channel_id === "string") {
    const channel = await client.channels.fetch(settings.leave_channel_id).catch(() => null);
    if (channel?.isSendable()) {
      const template = typeof settings.leave_message === "string"
        ? settings.leave_message
        : "See ya! {user} Thankyou for memories. GOODBYE";
      const caption = template.replaceAll("{user}", `${member}`).replaceAll("{server}", member.guild.name).slice(0, 4000);
      const embed = new EmbedBuilder()
        .setColor(0xe56b6f)
        .setDescription(caption)
        .setThumbnail(member.displayAvatarURL({ size: 512 }))
        .addFields({ name: "Server Statistics", value: `Total members: ${member.guild.memberCount}` })
        .setTimestamp();
      await channel.send({ embeds: [embed] }).catch((error) => console.error("Leave embed failed:", error));
    }
  }
  void sendLog(member.guild.id, "Member left", `${member.user.tag} left the server.`);
});

client.on(Events.GuildBanAdd, (ban) => {
  void sendLog(ban.guild.id, "Member banned", `${ban.user.tag} was banned from the server.`);
});

client.on(Events.GuildBanRemove, (ban) => {
  void sendLog(ban.guild.id, "Member unbanned", `${ban.user.tag} was unbanned from the server.`);
});

client.on(Events.GuildMemberUpdate, (before, after) => {
  const added = after.roles.cache.filter((role) => !before.roles.cache.has(role.id));
  const removed = before.roles.cache.filter((role) => !after.roles.cache.has(role.id));
  if (added.size) void sendLog(after.guild.id, "Roles added", `${after.user.tag} received ${added.map((role) => role.name).join(", ")}.`);
  if (removed.size) void sendLog(after.guild.id, "Roles removed", `${after.user.tag} lost ${removed.map((role) => role.name).join(", ")}.`);
});

client.on(Events.ChannelCreate, (channel) => {
  if ("guild" in channel && channel.guild) void sendLog(channel.guild.id, "Channel created", `${channel} was created.`);
});

client.on(Events.ChannelDelete, (channel) => {
  if ("guild" in channel && channel.guild) void sendLog(channel.guild.id, "Channel deleted", `Channel **${channel.name}** was deleted.`);
});

client.on(Events.MessageDelete, (message) => {
  if (message.guild && !message.author?.bot) {
    if (message.author) {
      const recentMessages = snipedMessages.get(message.channelId) ?? [];
      recentMessages.unshift({
        authorTag: message.author.tag,
        authorId: message.author.id,
        avatarUrl: message.author.displayAvatarURL(),
        content: message.content ?? "",
        createdAt: message.createdTimestamp,
        attachments: [...message.attachments.values()].map((attachment) => attachment.url),
      });
      if (recentMessages.length > 25) recentMessages.length = 25;
      snipedMessages.set(message.channelId, recentMessages);
    }
    void sendLog(message.guild.id, "Message deleted", `A message by ${message.author ?? "an unknown user"} was deleted in <#${message.channelId}>.\n${message.content?.slice(0, 1000) || "Message content unavailable."}`);
  }
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  if (oldMessage.guild && !oldMessage.author?.bot && oldMessage.content !== newMessage.content) {
    const before = oldMessage.content?.slice(0, 500) || "Unavailable";
    const after = newMessage.content?.slice(0, 500) || "Unavailable";
    void sendLog(oldMessage.guild.id, "Message edited", `Message by ${oldMessage.author ?? "unknown user"} in <#${oldMessage.channelId}>\nBefore: ${before}\nAfter: ${after}`);
  }
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  if (before.guild.id === after.guild.id && before.channelId !== after.channelId) {
    const member = after.member ?? before.member;
    const sessionKey = `${before.guild.id}:${member?.id ?? ""}`;
    if (!before.channelId && after.channelId) {
      voiceSessions.set(sessionKey, Date.now());
    } else if (before.channelId && !after.channelId) {
      const startedAt = voiceSessions.get(sessionKey);
      if (startedAt && member) {
        void database.recordVoiceMinutes(before.guild.id, member.id, Math.floor((Date.now() - startedAt) / 60_000));
      }
      voiceSessions.delete(sessionKey);
    }
    void sendLog(before.guild.id, "Voice activity", `${member?.user.tag ?? "A member"} ${before.channelId ? "left" : "joined"} voice ${before.channelId ? `<#${before.channelId}>` : `<#${after.channelId}>`}.`);
  }
});

client.on(Events.AutoModerationActionExecution, (execution) => {
  void sendLog(execution.guild.id, "AutoMod action", `${execution.user ?? "A member"} matched **${execution.autoModerationRule?.name ?? "a moderation rule"}** in ${execution.channel ? `<#${execution.channel.id}>` : "a channel"}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.guild) return;
  try {
    if (interaction.customId === "giveaway:enter") {
      const giveaway = await database.getGiveaway(interaction.message.id);
      if (!giveaway || giveaway.status !== "active" || giveaway.endsAt <= Date.now()) {
        await interaction.reply({ content: "This giveaway has ended.", ephemeral: true });
        return;
      }
      if (interaction.user.bot) {
        await interaction.reply({ content: "Bots cannot enter giveaways.", ephemeral: true });
        return;
      }
      const added = await database.addGiveawayEntry(giveaway.messageId, interaction.user.id);
      await interaction.reply({
        content: added ? `You're entered for **${giveaway.prize}**!` : "You're already entered in this giveaway.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId.startsWith("role-toggle:")) {
      const roleId = interaction.customId.slice("role-toggle:".length);
      const role = await interaction.guild.roles.fetch(roleId);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const botMember = await interaction.guild.members.fetchMe();
      const protectedPermissions = [
        PermissionsBitField.Flags.Administrator,
        PermissionsBitField.Flags.ManageGuild,
        PermissionsBitField.Flags.ManageRoles,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ManageWebhooks,
        PermissionsBitField.Flags.KickMembers,
        PermissionsBitField.Flags.BanMembers,
        PermissionsBitField.Flags.ModerateMembers,
        PermissionsBitField.Flags.ManageNicknames,
        PermissionsBitField.Flags.ManageEvents,
        PermissionsBitField.Flags.ManageThreads,
        PermissionsBitField.Flags.ManageGuildExpressions,
        PermissionsBitField.Flags.MentionEveryone,
        PermissionsBitField.Flags.MoveMembers,
        PermissionsBitField.Flags.MuteMembers,
        PermissionsBitField.Flags.DeafenMembers,
      ];
      if (!role || role.id === interaction.guild.id || role.managed || role.position >= botMember.roles.highest.position || protectedPermissions.some((permission) => role.permissions.has(permission))) {
        await interaction.reply({ content: "That role cannot be self-assigned.", ephemeral: true });
        return;
      }
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role);
        await interaction.reply({ content: `Removed **${role.name}**.`, ephemeral: true });
      } else {
        await member.roles.add(role);
        await interaction.reply({ content: `Added **${role.name}**.`, ephemeral: true });
      }
      return;
    }

    if (interaction.customId === "ticket:create") {
      const guild = interaction.guild;
      const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.name === `ticket-${interaction.user.id}`);
      if (existing) {
        await interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
        return;
      }
      const settings = await database.getSettings(guild.id);
      const supportRoleId = typeof settings.ticket_support_role_id === "string" ? settings.ticket_support_role_id : null;
      const permissionOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: client.user!.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
        ...(supportRoleId
          ? [{ id: supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }]
          : []),
      ];
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.id}`,
        type: ChannelType.GuildText,
        permissionOverwrites,
      });
      await database.addTicket(channel.id, guild.id, interaction.user.id);
      const closeButton = new ButtonBuilder().setCustomId("ticket:close").setLabel("Close ticket").setStyle(ButtonStyle.Danger);
      await channel.send({
        content: `${interaction.user} ${supportRoleId ? `<@&${supportRoleId}>` : ""}`,
        embeds: [new EmbedBuilder().setColor(0x55c278).setTitle("Support ticket").setDescription("Describe what you need help with. A moderator will be with you shortly.")],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton)],
      });
      await interaction.reply({ content: `Your ticket is ready: ${channel}`, ephemeral: true });
      return;
    }

    if (interaction.customId === "ticket:close") {
      const ticket = await database.getTicket(interaction.channelId);
      if (!ticket) {
        await interaction.reply({ content: "This is not an active ticket.", ephemeral: true });
        return;
      }
      const canClose = interaction.user.id === ticket.userId || interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels);
      if (!canClose) {
        await interaction.reply({ content: "Only the ticket creator or a moderator can close this ticket.", ephemeral: true });
        return;
      }
      await interaction.reply({ content: "Closing this ticket...", ephemeral: true });
      await database.removeTicket(interaction.channelId);
      await interaction.channel?.delete("Ticket closed");
    }
  } catch (error) {
    console.error("Button interaction failed:", error);
    const reply = { content: "That action failed. Please try again or contact a moderator.", ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => undefined);
    else await interaction.reply(reply).catch(() => undefined);
  }
});

async function start(): Promise<void> {
  try {
    await database.initialize();
    await database.pruneActivity();
    await client.login(config.botToken);
  } catch (error) {
    console.error("Bot startup failed:", error);
    await database.close();
    process.exitCode = 1;
  }
}

void start();