export const PREFIX = ",";

export const config = {
  botToken: process.env.BOT_TOKEN ?? "",
  tursoUrl: process.env.TURSO_DATABASE_URL ?? "",
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN ?? "",
  twitchClientId: process.env.TWITCH_CLIENT_ID ?? "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
  birthdayGifUrl: process.env.BIRTHDAY_GIF_URL || "https://media.giphy.com/media/feio2yIUMtdqWjRiaF/giphy.gif",
};

export function validateConfig(): string[] {
  const missing: string[] = [];
  if (!config.botToken) missing.push("BOT_TOKEN");
  if (!config.tursoUrl) missing.push("TURSO_DATABASE_URL");
  if (!config.tursoAuthToken) missing.push("TURSO_AUTH_TOKEN");
  return missing;
}