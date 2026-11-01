import { XMLParser } from "fast-xml-parser";
import { EmbedBuilder, type Client } from "discord.js";
import type { AlertSource, Database } from "./database.js";
import { config } from "./config.js";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
let twitchAccessToken = "";
let twitchTokenExpiresAt = 0;

type AlertEvent = {
  event: string;
  live: boolean;
  title?: string;
  channelName?: string;
  category?: string;
  viewerCount?: number;
  startedAt?: Date;
  thumbnailUrl?: string;
  url?: string;
};

async function twitchToken(): Promise<string> {
  if (twitchAccessToken && Date.now() < twitchTokenExpiresAt) return twitchAccessToken;
  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", config.twitchClientId);
  url.searchParams.set("client_secret", config.twitchClientSecret);
  url.searchParams.set("grant_type", "client_credentials");
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) throw new Error(`Twitch token request failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string; expires_in: number };
  twitchAccessToken = data.access_token;
  twitchTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return twitchAccessToken;
}

async function getEvent(source: AlertSource): Promise<AlertEvent | undefined> {
  if (source.platform === "twitch") {
    if (!config.twitchClientId || !config.twitchClientSecret) return undefined;
    const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(source.source_key)}`, {
      headers: { "Client-Id": config.twitchClientId, Authorization: `Bearer ${await twitchToken()}` },
    });
    if (!response.ok) throw new Error(`Twitch API request failed: ${response.status}`);
    const data = (await response.json()) as {
      data: Array<{
        id: string;
        title: string;
        user_name: string;
        user_login: string;
        game_name: string;
        viewer_count: number;
        started_at: string;
        thumbnail_url: string;
      }>;
    };
    const stream = data.data[0];
    if (!stream) return { event: "", live: false };
    const login = stream.user_login || source.source_key;
    return {
      event: stream.id,
      live: true,
      title: stream.title,
      channelName: stream.user_name,
      category: stream.game_name,
      viewerCount: stream.viewer_count,
      startedAt: new Date(stream.started_at),
      thumbnailUrl: stream.thumbnail_url.replace("{width}", "1280").replace("{height}", "720"),
      url: `https://www.twitch.tv/${encodeURIComponent(login)}`,
    };
  }

  if (source.platform === "kick") {
    const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(source.source_key)}`, {
      headers: { Accept: "application/json", "User-Agent": "ValkyrDiscordBot/1.0" },
    });
    if (!response.ok) throw new Error(`Kick API request failed: ${response.status}`);
    const data = (await response.json()) as {
      livestream?: { is_live?: boolean; id?: number; session_title?: string };
      slug?: string;
    };
    const stream = data.livestream;
    return stream?.is_live
      ? { event: String(stream.id ?? stream.session_title ?? "live"), live: true, title: `${data.slug ?? source.source_key}: ${stream.session_title ?? "is live"}` }
      : { event: "", live: false };
  }

  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.source_key)}`);
  if (!response.ok) throw new Error(`YouTube feed request failed: ${response.status}`);
  const parsed = xmlParser.parse(await response.text()) as {
    feed?: { entry?: { id?: string; title?: string; link?: { "@_href"?: string } } | Array<{ id?: string; title?: string; link?: { "@_href"?: string } }> };
  };
  const entry = Array.isArray(parsed.feed?.entry) ? parsed.feed?.entry[0] : parsed.feed?.entry;
  return entry?.id
    ? { event: entry.id, live: true, title: `New YouTube video: ${entry.title ?? source.source_key} ${entry.link?.["@_href"] ?? ""}` }
    : undefined;
}

export function startAlertPolling(client: Client, database: Database): void {
  const poll = async (): Promise<void> => {
    for (const source of await database.getAlerts()) {
      try {
        const event = await getEvent(source);
        if (!event) continue;
        const shouldAnnounce = source.platform === "youtube"
          ? Boolean(event.event && event.event !== source.last_event)
          : event.live && (!source.last_live || event.event !== source.last_event);

        if (shouldAnnounce) {
          const settings = await database.getSettings(source.guild_id);
          const channelId = settings.alerts_channel_id;
          if (typeof channelId === "string") {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel?.isSendable()) {
              if (source.platform === "twitch" && event.live && event.url) {
                const embed = new EmbedBuilder()
                  .setColor(0x9146ff)
                  .setAuthor({ name: `${event.channelName ?? source.source_key} is live on Twitch`, url: event.url })
                  .setTitle(event.title || "Live now")
                  .setURL(event.url)
                  .setDescription(`Playing **${event.category || "a game or category"}**\n**${event.viewerCount?.toLocaleString() ?? "?"}** viewers`)
                  .setFooter({ text: "Watch live on Twitch" });
                if (event.thumbnailUrl) embed.setImage(event.thumbnailUrl);
                if (event.startedAt && !Number.isNaN(event.startedAt.getTime())) embed.setTimestamp(event.startedAt);
                await channel.send({
                  content: `🔴 **${event.channelName ?? source.source_key} is live!**`,
                  embeds: [embed],
                });
              } else {
                await channel.send({
                  embeds: [new EmbedBuilder().setColor(0x55c278).setDescription(event.title ?? `${source.source_key} is live!`)],
                });
              }
            }
          }
        }
        await database.updateAlert(source, event.event, event.live);
      } catch (error) {
        console.error(`Alert polling failed for ${source.platform}/${source.source_key}:`, error);
      }
    }
  };
  void poll();
  setInterval(() => void poll(), 120_000);
}