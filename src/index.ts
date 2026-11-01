import "dotenv/config";
import {
  ActionRowBuilder,
  AttachmentBuilder,
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
import { renderStatusCard } from "./statusCard.js";

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
  "statusstyle color|font|background|reset (level 100+)",
  "afk [reason], prof [@user], banner [@user], snipe [@user]",
  "daily, rep @user|top, lb rep",
  "birthday set <month> <day>, birthday clear",
  "ship @user @user, wanted [@user], text <effect> <text>",
  "family manage|adopt @user|disown @user|runaway [@parent]",
  "family name <name|clear>",
  "family children|parent|tree|siblings [@user]",
  "family sibling @user [brother|sister], unsibling @user, relationship @user @user",
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
  "level max @user, set level @user <1-100>",
];
const botOwnerIds = new Set<string>(config.botOwnerIds);
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

function transformText(effect: string, input: string): string | undefined {
  switch (effect.toLowerCase()) {
    case "upper":
    case "uppercase":
      return input.toLocaleUpperCase();
    case "lower":
    case "lowercase":
      return input.toLocaleLowerCase();
    case "reverse":
      return Array.from(input).reverse().join("");
    case "mock":
      return Array.from(input).map((character, index) => index % 2 ? character.toLocaleLowerCase() : character.toLocaleUpperCase()).join("");
    case "clap":
      return `👏 ${input.trim().split(/\s+/).join(" 👏 ")} 👏`;
    case "spoiler":
      return `||${input}||`;
    case "binary":
      return Array.from(input).map((character) => character.codePointAt(0)!.toString(2).padStart(8, "0")).join(" ");
    case "owo":
      return input.replace(/[rl]/gi, (character) => character === character.toUpperCase() ? "W" : "w").replace(/n([aeiou])/gi, (_, vowel: string) => `ny${vowel}`);
    default:
      return undefined;
  }
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
    if (command === "ship") {
      const users = [...message.mentions.users.values()].slice(0, 2);
      if (users.length !== 2) {
        await message.reply(`Usage: \`${PREFIX}ship @user @user\``);
        return;
      }
      const compatibility = Math.floor(Math.random() * 101);
      const result = compatibility >= 50 ? "Love" : "Lust";
      const embed = new EmbedBuilder()
        .setColor(result === "Love" ? 0xff6b9a : 0xb44cff)
        .setTitle(`${users[0]!.username} × ${users[1]!.username}`)
        .setDescription(`💞 **${compatibility}% ${result}**`)
        .setThumbnail(users[0]!.displayAvatarURL());
      await message.reply({ embeds: [embed] });
      return;
    }
    if (command === "wanted") {
      const target = message.mentions.users.first() ?? message.author;
      const bounty = Math.floor(Math.random() * 999_000_000) + 1_000_000;
      const embed = new EmbedBuilder()
        .setColor(0xe4b84b)
        .setTitle("WANTED")
        .setDescription(`**${target.username}**\n\nBounty: **$${bounty.toLocaleString()}**`)
        .setThumbnail(target.displayAvatarURL({ size: 512 }))
        .setFooter({ text: "Valkyr wanted board" });
      await message.reply({ embeds: [embed] });
      return;
    }
    if (command === "text") {
      const effect = args[0]?.toLowerCase();
      const input = args.slice(1).join(" ").trim();
      if (!effect || !input || input.length > 1000) {
        await message.reply(`Usage: \`${PREFIX}text <upper|lower|reverse|mock|clap|spoiler|binary|owo> <text>\``);
        return;
      }
      const output = transformText(effect, input);
      if (!output) {
        await message.reply(`Unknown text effect. Try: \`upper\`, \`lower\`, \`reverse\`, \`mock\`, \`clap\`, \`spoiler\`, \`binary\`, or \`owo\`.`);
        return;
      }
      if (output.length > 1900) {
        await message.reply("That transformed text is too long to send. Try a shorter message or another effect.");
        return;
      }
      await message.reply({ content: output, allowedMentions: { parse: [] } });
      return;
    }
    if (command === "family") {
      const action = args[0]?.toLowerCase();
      if (!action || action === "manage") {
        const embed = new EmbedBuilder()
          .setColor(0x55c278)
          .setTitle("Family commands")
          .setDescription([
            `\`${PREFIX}family adopt @user\` · Adopt a member as your child.`,
            `\`${PREFIX}family disown @user\` · Remove your child relationship.`,
            `\`${PREFIX}family runaway [@parent]\` · Leave one of your parent relationships.`,
            `\`${PREFIX}family children|parent|siblings|tree [@user]\` · View family members.`,
            `\`${PREFIX}family sibling @user [brother|sister]\` · Request a sibling bond.`,
            `\`${PREFIX}family unsibling @user\` · End a direct sibling bond.`,
            `\`${PREFIX}family name <name|clear>\` · Rename your connected family tree.`,
            `\`${PREFIX}family relationship @user @user\` · Find the relationship path.`,
          ].join("\n"));
        await message.reply({ embeds: [embed] });
        return;
      }

      if (action === "name") {
        const requestedName = args.slice(1).join(" ").trim();
        if (!requestedName) {
          await message.reply(`Usage: \`${PREFIX}family name <name|clear>\``);
          return;
        }
        const familyName = requestedName.toLowerCase() === "clear" ? null : requestedName.slice(0, 40);
        const graph = await database.getFamilyGraph(guildId);
        const connected = new Set([message.author.id]);
        const queue = [message.author.id];
        while (queue.length) {
          const currentId = queue.shift()!;
          for (const edge of graph) {
            if (edge.fromId === currentId && !connected.has(edge.toId)) {
              connected.add(edge.toId);
              queue.push(edge.toId);
            }
          }
        }
        await database.setFamilyName(guildId, [...connected], familyName);
        await message.reply({
          content: familyName
            ? `Your family tree is now named **${familyName}**.`
            : "Your family tree name has been cleared.",
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (action === "relationship") {
        const [first, second] = [...message.mentions.users.values()];
        if (!first || !second || first.id === second.id) {
          await message.reply(`Usage: \`${PREFIX}family relationship @user @user\``);
          return;
        }
        const graph = await database.getFamilyGraph(guildId);
        const visited = new Set([first.id]);
        const previous = new Map<string, { fromId: string; label: string }>();
        const queue = [first.id];
        while (queue.length && !visited.has(second.id)) {
          const current = queue.shift()!;
          for (const edge of graph) {
            if (edge.fromId !== current || visited.has(edge.toId)) continue;
            visited.add(edge.toId);
            previous.set(edge.toId, {
              fromId: current,
              label: edge.kind === "parent" ? "is parent of" : edge.kind === "child" ? "is child of" : "is sibling of",
            });
            queue.push(edge.toId);
          }
        }
        if (!visited.has(second.id)) {
          await message.reply(`${first} and ${second} have no saved family relationship.`);
          return;
        }
        const path: string[] = [];
        let currentId = second.id;
        while (currentId !== first.id) {
          const step = previous.get(currentId);
          if (!step) break;
          path.unshift(`<@${step.fromId}> ${step.label} <@${currentId}>`);
          currentId = step.fromId;
        }
        await message.reply({
          embeds: [new EmbedBuilder().setColor(0x55c278).setTitle("Family relationship").setDescription(path.join("\n"))],
        });
        return;
      }

      if (action === "adopt") {
        const target = await resolveMember(message, args[1]);
        if (!target || target.id === message.author.id || target.user.bot) {
          await message.reply(`Usage: \`${PREFIX}family adopt @user\` (choose another human member).`);
          return;
        }
        const result = await database.addFamilyParent(guildId, message.author.id, target.id);
        const response = result === "added"
          ? `${message.author} welcomed ${target} into their family as a child.`
          : result === "already"
            ? `${target} is already listed as your child.`
            : result === "limit"
              ? `${target} already has the maximum of two parents.`
              : "That adoption would create an invalid family cycle.";
        await message.reply(response);
        return;
      }

      if (action === "disown") {
        const target = await resolveMember(message, args[1]);
        if (!target) {
          await message.reply(`Usage: \`${PREFIX}family disown @user\``);
          return;
        }
        const removed = await database.removeFamilyParent(guildId, message.author.id, target.id);
        await message.reply(removed ? `${target} is no longer listed as your child.` : `${target} is not listed as your child.`);
        return;
      }

      if (action === "runaway") {
        const parents = await database.getFamilyParents(guildId, message.author.id);
        const selectedParent = message.mentions.users.first()?.id;
        if (!parents.length) {
          await message.reply("You don't have a saved parent relationship to leave.");
          return;
        }
        if (!selectedParent && parents.length > 1) {
          await message.reply(`You have more than one parent. Choose one: ${parents.map((id) => `<@${id}>`).join(", ")}`);
          return;
        }
        const parentId = selectedParent ?? parents[0]!;
        if (!parents.includes(parentId)) {
          await message.reply("That member isn't one of your saved parents.");
          return;
        }
        await database.removeFamilyParent(guildId, parentId, message.author.id);
        await message.reply(`You left your family relationship with <@${parentId}>.`);
        return;
      }

      if (action === "sibling") {
        const target = await resolveMember(message, args[1]);
        const requesterRole = args[2]?.toLowerCase() || "sibling";
        if (!target || target.id === message.author.id || target.user.bot || !["brother", "sister", "sibling"].includes(requesterRole)) {
          await message.reply(`Usage: \`${PREFIX}family sibling @user [brother|sister]\``);
          return;
        }
        const requestId = await database.createSiblingRequest(guildId, message.author.id, target.id, requesterRole);
        if (!requestId) {
          await message.reply("A sibling bond already exists or a request is already pending.");
          return;
        }
        if (!message.channel.isSendable()) return;
        const accept = new ButtonBuilder().setCustomId(`family:sibling:${requestId}:accept`).setLabel("Accept").setStyle(ButtonStyle.Success);
        const decline = new ButtonBuilder().setCustomId(`family:sibling:${requestId}:decline`).setLabel("Decline").setStyle(ButtonStyle.Secondary);
        await message.channel.send({
          content: `${target}, ${message.author} sent you a family sibling request.`,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(accept, decline)],
        });
        return;
      }

      if (action === "unsibling") {
        const target = await resolveMember(message, args[1]);
        if (!target || target.id === message.author.id) {
          await message.reply(`Usage: \`${PREFIX}family unsibling @user\``);
          return;
        }
        const removed = await database.removeFamilySibling(guildId, message.author.id, target.id);
        await message.reply(removed ? `Your sibling bond with ${target} has ended.` : `You don't have a direct sibling bond with ${target}.`);
        return;
      }

      if (["children", "parent", "siblings", "tree"].includes(action)) {
        const target = message.mentions.users.first() ?? message.author;
        const relations = await database.getFamilyRelations(guildId, target.id);
        const parents = relations.filter((relation) => relation.relation === "parent");
        const children = relations.filter((relation) => relation.relation === "child");
        const siblings = relations.filter((relation) => relation.relation === "sibling");
        if (action === "children" || action === "parent" || action === "siblings") {
          const selected = action === "children" ? children : action === "parent" ? parents : siblings;
          const formatted = selected.slice(0, 20).map((relation) =>
            relation.relation === "sibling" && relation.role && relation.role !== "sibling"
              ? `<@${relation.userId}> (${relation.role})`
              : `<@${relation.userId}>`,
          );
          await message.reply({
            embeds: [new EmbedBuilder()
              .setColor(0x55c278)
              .setTitle(`${target.username}'s ${action}`)
              .setDescription(formatted.join("\n") || "No saved family members.")],
          });
          return;
        }
        const formatRelations = (items: typeof parents): string => items
          .slice(0, 18)
          .map((relation) => `<@${relation.userId}>`)
          .join(", ") || "None";
        const familyName = await database.getFamilyName(guildId, target.id);
        const treeEmbed = new EmbedBuilder()
          .setColor(0x55c278)
          .setTitle(familyName ? `${familyName} family tree` : `${target.username}'s family tree`)
          .setThumbnail(target.displayAvatarURL({ size: 512 }))
          .addFields(
            { name: "Parents", value: formatRelations(parents), inline: true },
            { name: "Siblings", value: formatRelations(siblings), inline: true },
            { name: "Children", value: formatRelations(children), inline: false },
          );
        const memberProfiles: EmbedBuilder[] = [];
        for (const relation of relations.slice(0, 9)) {
          const member = await message.guild.members.fetch(relation.userId).catch(() => null);
          const user = member?.user ?? await client.users.fetch(relation.userId).catch(() => null);
          if (!user) continue;
          const relationName = relation.relation === "parent"
            ? "Parent"
            : relation.relation === "child"
              ? "Child"
              : relation.role && relation.role !== "sibling"
                ? relation.role
                : "Sibling";
          const profile = new EmbedBuilder()
            .setColor(0x687182)
            .setAuthor({ name: `${user.tag} · ${relationName}`, iconURL: user.displayAvatarURL() })
            .setThumbnail(user.displayAvatarURL({ size: 256 }));
          memberProfiles.push(profile);
        }
        await message.reply({ embeds: [treeEmbed, ...memberProfiles] });
        return;
      }

      await message.reply(`Use \`${PREFIX}family manage\` to see family commands.`);
      return;
    }
    if (command === "set" && args[0]?.toLowerCase() === "level") {
      await loadBotOwnerIds();
      if (!botOwnerIds.has(message.author.id)) {
        await message.reply("Only the bot owner can set a member's level.");
        return;
      }
      const target = await resolveMember(message, args[1]);
      const level = Number(args[2]);
      if (!target || !Number.isInteger(level) || level < 1 || level > 100) {
        await message.reply(`Usage: \`${PREFIX}set level @user <1-100>\``);
        return;
      }
      await database.setXp(guildId, target.id, level * level * 100);
      await message.reply(`${target} was set to level ${level}.`);
      return;
    }

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
    if (command === "statusstyle") {
      const xp = await database.getXp(guildId, message.author.id);
      const level = Math.floor(Math.sqrt(xp / 100));
      if (level < 100) {
        await message.reply(`Status design customization unlocks at level 100. You are level ${level}.`);
        return;
      }
      const action = args[0]?.toLowerCase();
      const style = await database.getStatusCustomization(guildId, message.author.id);
      if (action === "color") {
        const color = args[1]?.toLowerCase();
        if (!color || !/^#[0-9a-f]{6}$/.test(color)) {
          await message.reply(`Usage: \`${PREFIX}statusstyle color #RRGGBB\` (example: \`${PREFIX}statusstyle color #ff6699\`).`);
          return;
        }
        style.color = color;
      } else if (action === "font") {
        const font = args[1]?.toLowerCase();
        if (font !== "sans" && font !== "serif" && font !== "mono") {
          await message.reply(`Choose a font: \`${PREFIX}statusstyle font sans|serif|mono\`.`);
          return;
        }
        style.font = font;
      } else if (action === "background") {
        if (args[1]?.toLowerCase() === "clear") {
          style.backgroundBase64 = null;
        } else {
          const attachment = message.attachments.first();
          if (!attachment || attachment.size > 800_000) {
            await message.reply(`Attach a PNG, JPEG, or WebP image smaller than 800 KB, or use \`${PREFIX}statusstyle background clear\`.`);
            return;
          }
          const url = new URL(attachment.url);
          if (!url.protocol.startsWith("https") || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
            await message.reply("For safety, backgrounds must be uploaded as a Discord attachment.");
            return;
          }
          const response = await fetch(url);
          if (!response.ok) {
            await message.reply("I couldn't download that image. Please re-upload it and try again.");
            return;
          }
          const mime = (response.headers.get("content-type") ?? attachment.contentType ?? "").split(";")[0]!.toLowerCase();
          if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) {
            await message.reply("Backgrounds must be PNG, JPEG, or WebP images.");
            return;
          }
          const imageData = Buffer.from(await response.arrayBuffer());
          if (imageData.length > 800_000) {
            await message.reply("That image is too large after download. Use an image under 800 KB.");
            return;
          }
          style.backgroundBase64 = imageData.toString("base64");
        }
      } else if (action === "reset") {
        style.color = "#55c278";
        style.font = "sans";
        style.backgroundBase64 = null;
      } else {
        await message.reply(`Usage: \`${PREFIX}statusstyle color|font|background|reset ...\``);
        return;
      }
      await database.setStatusCustomization(guildId, message.author.id, style);
      await message.reply("Your status card design has been saved. View it with `,status`.");
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
      const style = await database.getStatusCustomization(guildId, user.id);
      const nextLevelXp = (level + 1) * (level + 1) * 100;
      const card = await renderStatusCard({
        displayName: member.displayName,
        username: user.tag,
        avatarUrl: user.displayAvatarURL({ extension: "png", size: 256 }),
        bio: metrics.bio ?? "No bio set. Use ,setbio <text> to add one.",
        accountAge,
        serverTime,
        level,
        levelTitle: `${title.emoji} ${title.name}`,
        xp,
        nextLevelXp,
        wordsSent: metrics.wordsSent,
        commandsUsed: metrics.commandsUsed,
        voiceTime: formatDuration(metrics.voiceMinutes * 60_000),
        accentColor: style.color,
        font: style.font,
        backgroundBase64: style.backgroundBase64,
      });
      await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x55c278)
          .setTitle(`${member.displayName}'s status`)
          .setImage("attachment://status-card.png")],
        files: [new AttachmentBuilder(card, { name: "status-card.png" })],
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
    if (interaction.customId.startsWith("family:sibling:")) {
      const [, , requestIdText, action] = interaction.customId.split(":");
      const requestId = Number(requestIdText);
      if (!Number.isInteger(requestId) || !["accept", "decline"].includes(action ?? "")) {
        await interaction.reply({ content: "That family request is invalid.", ephemeral: true });
        return;
      }
      const result = await database.respondToSiblingRequest(
        interaction.guild.id,
        requestId,
        interaction.user.id,
        action === "accept",
      );
      if (result === "not-target") {
        await interaction.reply({ content: "Only the invited member can respond to this request.", ephemeral: true });
        return;
      }
      if (result === "missing") {
        await interaction.reply({ content: "This sibling request has already been answered or expired.", ephemeral: true });
        return;
      }
      await interaction.reply({
        content: result === "accepted" ? "Sibling request accepted!" : "Sibling request declined.",
        ephemeral: true,
      });
      await interaction.message.edit({ components: [] }).catch(() => undefined);
      return;
    }

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