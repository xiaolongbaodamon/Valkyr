# Valkyr Discord Bot

Valkyr is a TypeScript Discord bot with a `,` prefix and persistent guild settings stored in Turso (libSQL).

## Run locally

Requirements: Node.js 20 or newer, a Discord application/bot, and a Turso database.

1. In the Discord Developer Portal, enable **Server Members Intent** and **Message Content Intent**. Invite the bot with the `bot` scope and permissions for messages, moderation, roles, channels, and member events. The bot needs **Manage Server** permission to read invites for welcome attribution and to configure AutoMod; invite attribution displays `Unknown` if invite access is unavailable.
2. Create a Turso database and auth token. The Turso CLI commands are `turso db create valkyr`, `turso db show valkyr --url`, and `turso db tokens create valkyr`.
3. Copy `.env.example` to `.env`, then set `BOT_TOKEN`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN`. Twitch alerts also need a Twitch application client ID and secret.
4. Install and run:

   ```sh
   npm install
   npm run dev
   ```

   For production or Wispbyte, use `npm start` as the startup command; its `prestart` step builds the TypeScript output before launching the bot.

The bot creates its tables in Turso at startup. Keep the database URL and auth token private. Linking GitHub to Turso does not provide application credentials to this bot; put the values in the hosting provider's environment/secrets configuration as well as local `.env` for development.

## Commands

All commands start with a comma. `,help` shows member commands to everyone; the bot owner, server owner, and administrators see server, role, channel, and moderation sections. The separate bot-owner section is shown only to IDs in `BOT_OWNER_IDS` (which defaults to the configured bot owner), never to a server owner/admin solely because of their server permissions. Commands still enforce their required Discord permissions when run.

| Command | Purpose |
| --- | --- |
| `,help`, `,ping`, `,stats`, `,status [@user]` | Server stats and a member profile with account age, server tenure, tracked words/commands, voice time, and XP-earned level title |
| `,setbio <text>`, `,setbio clear` | Set or clear the personal bio shown on your `,status` card (up to 300 characters) |
| `,welcome #channel | message`, `,welcome off` | Configure the welcome embed; supports `{user}` and `{server}`, account age, invite attribution, and member count |
| `,leave #channel | message`, `,leave off` | Configure the member-leave embed; default caption: “See ya! {user} Thankyou for memories. GOODBYE” |
| `,autorole @role`, `,autorole off` | Assign a role to new members |
| `,logs #channel`, `,logs off` | Log joins, leaves, message edits/deletions, voice moves, and moderation |
| `,kick @user [reason]`, `,ban @user [reason]`, `,softban @user [reason]`, `,timeout @user <minutes> [reason]`, `,mute @user <minutes> [reason]` | Moderation actions |
| `,warn @user <reason>`, `,warnings @user`, `,clear <1-100>` | Persistent warnings and message cleanup |
| `,lock [#channel]`, `,unlock [#channel]` | Lock or unlock a text channel |
| `,level enable|disable|top`, `,rank [@user]` | XP, leaderboard, rank card, and the level title/emoji from the level reference |
| `,level reward <level> @role` | Award a role on reaching a level |
| `,level ignore-channel|allow-channel #channel`, `,level ignore-role|allow-role @role` | Exclude or restore XP sources |
| `,daily` | Claim 50 XP every 24 hours; one-time streak bonuses: +200 XP at 7 days, +500 at 30, +1000 at 100 |
| `,rep @user`, `,rep top`, `,lb rep` | Give reputation or view the helpful-member leaderboard (legacy `,leaderboard rep` remains supported) |
| `,birthday set <month> <day>`, `,birthday clear` | Save or remove your annual birthday |
| `,birthday channel #channel|off` | Set the server's birthday announcement channel (Manage Server required) |
| `,automod enable|disable` | Enable Discord spam filtering and Valkyr attachment/poll filtering |
| `,afk [reason]` | Set an AFK status, clear it on your next message, and notify people who mention you |
| `,prof [@user]`, `,banner [@user]` | Show a large profile embed or the user's Discord banner |
| `,snipe [@user]` | Recreate the latest cached deleted message in the channel, optionally filtered to one user |
| `,giveaway start <30s|10m|2h|1d> <prize>`, `,giveaway reroll` | Run a button-entry giveaway and choose/reroll a winner |
| `,role add @role [label]` | Post a safe self-assign role button |
| `,ticket setup @support-role` | Post a ticket panel; tickets are private to the member and support role |
| `,alerts channel #channel|off` | Choose where notifications are posted |
| `,alerts add twitch|kick <channel>` | Monitor a Twitch or Kick channel for live sessions |
| `,alerts add youtube <channel-id>` | Monitor a YouTube channel ID (starts with `UC`) for new uploads |
| `,alerts list`, `,alerts remove <id>` | Manage notification sources |

Twitch alerts use `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` from the process environment and include the live title, category, viewer count, start time, preview image, and link. Save the variables in Wispbyte and restart the bot after updating them.

Birthday announcements are sent at midnight UTC and use `BIRTHDAY_GIF_URL` for the animated image (the default is a public GIPHY GIF). Daily claims give 50 XP every 24 hours; a gap of 48 hours or more resets the streak. Each milestone bonus is awarded once per member, even if they later rebuild a streak. Reputation has a 24-hour per-giver cooldown. Channel lock/unlock commands are only listed for the bot owner, server owner, and administrators; those same users can run them. Other moderation commands retain their individual Discord permission checks. Alerts are checked every two minutes. Twitch alerts require `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`; YouTube alerts announce new feed uploads. The 30-day activity summary tracks messages, joins, leaves, voice minutes, and active members. Member word and command totals begin when the bot is installed; voice time is an estimate based on tracked voice sessions and is not retroactive across bot downtime. For Wispbyte, select Node.js 20 or newer, set the startup command to `npm start`, and add `BOT_TOKEN`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN` as environment variables in the panel. Add Twitch credentials there if Twitch alerts are needed. The bot needs **View Channel**, **Send Messages**, **Embed Links**, and the relevant role/channel management permissions in Discord.