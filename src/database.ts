import { createClient, type Client } from "@libsql/client";

export type AlertPlatform = "twitch" | "youtube" | "kick";

export type AlertSource = {
  id: number;
  guild_id: string;
  platform: AlertPlatform;
  source_key: string;
  last_event: string;
  last_live: number;
};

export type ActivitySummary = {
  messages: number;
  joins: number;
  leaves: number;
  voiceMinutes: number;
  topMembers: Array<{ userId: string; messages: number }>;
  dailyMessages: Array<{ day: string; messages: number }>;
};

export type Giveaway = {
  messageId: string;
  guildId: string;
  channelId: string;
  hostId: string;
  prize: string;
  endsAt: number;
  status: "active" | "ended";
  winnerIds: string[];
};

export type DailyClaimResult = {
  claimed: boolean;
  streak: number;
  remainingMs: number;
  milestone?: number;
  bonusXp: number;
};

function valueAsString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function valueAsNumber(value: unknown): number {
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : 0;
}

export class Database {
  private readonly client: Client;

  constructor(url: string, authToken: string) {
    this.client = createClient({ url, authToken });
  }

  async initialize(): Promise<void> {
    const schema = [
      `CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        welcome_channel_id TEXT,
        welcome_message TEXT NOT NULL DEFAULT 'Welcome {user} to {server}!',
        leave_channel_id TEXT,
        leave_message TEXT NOT NULL DEFAULT 'See ya! {user} Thankyou for memories. GOODBYE',
        autorole_id TEXT,
        log_channel_id TEXT,
        ticket_support_role_id TEXT,
        birthday_channel_id TEXT,
        alerts_channel_id TEXT,
        leveling_enabled INTEGER NOT NULL DEFAULT 1,
        automod_enabled INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS member_xp (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS level_rewards (
        guild_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, level)
      )`,
      `CREATE TABLE IF NOT EXISTS level_exclusions (
        guild_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, target_type, target_id)
      )`,
      `CREATE TABLE IF NOT EXISTS guild_daily_activity (
        guild_id TEXT NOT NULL,
        day TEXT NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        joins INTEGER NOT NULL DEFAULT 0,
        leaves INTEGER NOT NULL DEFAULT 0,
        voice_minutes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, day)
      )`,
      `CREATE TABLE IF NOT EXISTS member_daily_activity (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, day)
      )`,
      `CREATE TABLE IF NOT EXISTS member_metrics (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        bio TEXT,
        words_sent INTEGER NOT NULL DEFAULT 0,
        commands_used INTEGER NOT NULL DEFAULT 0,
        voice_minutes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS alert_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        source_key TEXT NOT NULL,
        last_event TEXT NOT NULL DEFAULT '',
        last_live INTEGER NOT NULL DEFAULT 0,
        UNIQUE (guild_id, platform, source_key)
      )`,
      `CREATE TABLE IF NOT EXISTS tickets (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS afk_status (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS giveaways (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        prize TEXT NOT NULL,
        ends_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        winner_ids TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE TABLE IF NOT EXISTS giveaway_entries (
        giveaway_message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        entered_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (giveaway_message_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS daily_claims (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_claim_at INTEGER NOT NULL,
        streak INTEGER NOT NULL DEFAULT 1,
        milestone_7_claimed INTEGER NOT NULL DEFAULT 0,
        milestone_30_claimed INTEGER NOT NULL DEFAULT 0,
        milestone_100_claimed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS reputation (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS rep_cooldowns (
        guild_id TEXT NOT NULL,
        giver_id TEXT NOT NULL,
        last_given_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, giver_id)
      )`,
      `CREATE TABLE IF NOT EXISTS birthdays (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        month INTEGER NOT NULL,
        day INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS birthday_announcements (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        year INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, year)
      )`,
    ];
    for (const statement of schema) await this.client.execute(statement);
    const settingsColumns = await this.client.execute("PRAGMA table_info(guild_settings)");
    const existingColumns = new Set(settingsColumns.rows.map((row) => valueAsString(row.name)));
    if (!existingColumns.has("ticket_support_role_id")) {
      await this.client.execute("ALTER TABLE guild_settings ADD COLUMN ticket_support_role_id TEXT");
    }
    if (!existingColumns.has("automod_enabled")) {
      await this.client.execute("ALTER TABLE guild_settings ADD COLUMN automod_enabled INTEGER NOT NULL DEFAULT 0");
    }
    if (!existingColumns.has("birthday_channel_id")) {
      await this.client.execute("ALTER TABLE guild_settings ADD COLUMN birthday_channel_id TEXT");
    }
    if (!existingColumns.has("leave_channel_id")) {
      await this.client.execute("ALTER TABLE guild_settings ADD COLUMN leave_channel_id TEXT");
    }
    if (!existingColumns.has("leave_message")) {
      await this.client.execute("ALTER TABLE guild_settings ADD COLUMN leave_message TEXT NOT NULL DEFAULT 'See ya! {user} Thankyou for memories. GOODBYE'");
    }
    const memberMetricColumns = await this.client.execute("PRAGMA table_info(member_metrics)");
    if (!memberMetricColumns.rows.some((row) => valueAsString(row.name) === "bio")) {
      await this.client.execute("ALTER TABLE member_metrics ADD COLUMN bio TEXT");
    }
  }

  async getSettings(guildId: string): Promise<Record<string, unknown>> {
    const result = await this.client.execute({
      sql: "SELECT * FROM guild_settings WHERE guild_id = ?",
      args: [guildId],
    });
    if (result.rows[0]) return result.rows[0] as Record<string, unknown>;
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)",
      args: [guildId],
    });
    const initialized = await this.client.execute({
      sql: "SELECT * FROM guild_settings WHERE guild_id = ?",
      args: [guildId],
    });
    return initialized.rows[0] as Record<string, unknown>;
  }

  async setSetting(guildId: string, key: string, value: string | number | null): Promise<void> {
    const allowed = new Set([
      "welcome_channel_id",
      "welcome_message",
      "leave_channel_id",
      "leave_message",
      "autorole_id",
      "log_channel_id",
      "ticket_support_role_id",
      "birthday_channel_id",
      "alerts_channel_id",
      "leveling_enabled",
      "automod_enabled",
    ]);
    if (!allowed.has(key)) throw new Error("Unknown guild setting");
    await this.getSettings(guildId);
    await this.client.execute({
      sql: `UPDATE guild_settings SET ${key} = ? WHERE guild_id = ?`,
      args: [value, guildId],
    });
  }

  async setBirthday(guildId: string, userId: string, month: number, day: number): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO birthdays (guild_id, user_id, month, day) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET month = excluded.month, day = excluded.day`,
      args: [guildId, userId, month, day],
    });
  }

  async removeBirthday(guildId: string, userId: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?", args: [guildId, userId] });
  }

  async getBirthdays(month: number, day: number): Promise<Array<{ guildId: string; userId: string }>> {
    const result = await this.client.execute({
      sql: "SELECT guild_id, user_id FROM birthdays WHERE month = ? AND day = ?",
      args: [month, day],
    });
    return result.rows.map((row) => ({ guildId: valueAsString(row.guild_id), userId: valueAsString(row.user_id) }));
  }

  async markBirthdayAnnounced(guildId: string, userId: string, year: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: "INSERT OR IGNORE INTO birthday_announcements (guild_id, user_id, year) VALUES (?, ?, ?)",
      args: [guildId, userId, year],
    });
    return result.rowsAffected > 0;
  }

  async hasBirthdayAnnouncement(guildId: string, userId: string, year: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT 1 FROM birthday_announcements WHERE guild_id = ? AND user_id = ? AND year = ? LIMIT 1",
      args: [guildId, userId, year],
    });
    return result.rows.length > 0;
  }

  async addWarning(guildId: string, userId: string, moderatorId: string, reason: string): Promise<void> {
    await this.client.execute({
      sql: "INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?)",
      args: [guildId, userId, moderatorId, reason],
    });
  }

  async getWarnings(guildId: string, userId: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: "SELECT reason, moderator_id, created_at FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10",
      args: [guildId, userId],
    });
    return result.rows.map((row) =>
      `${valueAsString(row.reason)} (by <@${valueAsString(row.moderator_id)}>, ${valueAsString(row.created_at)})`,
    );
  }

  async addXp(guildId: string, userId: string, amount: number): Promise<number> {
    const result = await this.client.execute({
      sql: `INSERT INTO member_xp (guild_id, user_id, xp) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp
        RETURNING xp`,
      args: [guildId, userId, amount],
    });
    return valueAsNumber(result.rows[0]?.xp);
  }

  async claimDaily(guildId: string, userId: string, now = Date.now()): Promise<DailyClaimResult> {
    const dayMs = 24 * 60 * 60 * 1000;
    let result = await this.client.execute({
      sql: "SELECT * FROM daily_claims WHERE guild_id = ? AND user_id = ?",
      args: [guildId, userId],
    });
    let row = result.rows[0];
    if (!row) {
      const inserted = await this.client.execute({
        sql: "INSERT OR IGNORE INTO daily_claims (guild_id, user_id, last_claim_at, streak) VALUES (?, ?, ?, 1)",
        args: [guildId, userId, now],
      });
      if (inserted.rowsAffected > 0) return { claimed: true, streak: 1, remainingMs: 0, bonusXp: 0 };
      result = await this.client.execute({
        sql: "SELECT * FROM daily_claims WHERE guild_id = ? AND user_id = ?",
        args: [guildId, userId],
      });
      row = result.rows[0];
    }
    if (!row) return { claimed: false, streak: 0, remainingMs: dayMs, bonusXp: 0 };

    const lastClaimAt = valueAsNumber(row.last_claim_at);
    const oldStreak = valueAsNumber(row.streak);
    const remainingMs = dayMs - (now - lastClaimAt);
    if (remainingMs > 0) return { claimed: false, streak: oldStreak, remainingMs, bonusXp: 0 };

    const nextStreak = now - lastClaimAt < dayMs * 2 ? oldStreak + 1 : 1;
    const milestone = nextStreak === 7 && !valueAsNumber(row.milestone_7_claimed)
      ? 7
      : nextStreak === 30 && !valueAsNumber(row.milestone_30_claimed)
        ? 30
        : nextStreak === 100 && !valueAsNumber(row.milestone_100_claimed)
          ? 100
          : undefined;
    const bonusXp = milestone === 7 ? 200 : milestone === 30 ? 500 : milestone === 100 ? 1000 : 0;
    const updated = await this.client.execute({
      sql: `UPDATE daily_claims SET
          last_claim_at = ?,
          streak = ?,
          milestone_7_claimed = CASE WHEN ? = 1 THEN 1 ELSE milestone_7_claimed END,
          milestone_30_claimed = CASE WHEN ? = 1 THEN 1 ELSE milestone_30_claimed END,
          milestone_100_claimed = CASE WHEN ? = 1 THEN 1 ELSE milestone_100_claimed END
        WHERE guild_id = ? AND user_id = ? AND last_claim_at = ? AND last_claim_at <= ?`,
      args: [now, nextStreak, Number(milestone === 7), Number(milestone === 30), Number(milestone === 100), guildId, userId, lastClaimAt, now - dayMs],
    });
    if (updated.rowsAffected > 0) return { claimed: true, streak: nextStreak, remainingMs: 0, milestone, bonusXp };

    const latest = await this.client.execute({
      sql: "SELECT streak, last_claim_at FROM daily_claims WHERE guild_id = ? AND user_id = ?",
      args: [guildId, userId],
    });
    const latestRow = latest.rows[0];
    return {
      claimed: false,
      streak: valueAsNumber(latestRow?.streak),
      remainingMs: Math.max(0, dayMs - (now - valueAsNumber(latestRow?.last_claim_at))),
      bonusXp: 0,
    };
  }

  async giveReputation(guildId: string, giverId: string, targetId: string, now = Date.now()): Promise<{ given: boolean; points: number; remainingMs: number }> {
    const cooldownMs = 24 * 60 * 60 * 1000;
    let cooldown = await this.client.execute({
      sql: "SELECT last_given_at FROM rep_cooldowns WHERE guild_id = ? AND giver_id = ?",
      args: [guildId, giverId],
    });
    const lastGivenAt = cooldown.rows[0] ? valueAsNumber(cooldown.rows[0].last_given_at) : undefined;
    if (lastGivenAt === undefined) {
      const inserted = await this.client.execute({
        sql: "INSERT OR IGNORE INTO rep_cooldowns (guild_id, giver_id, last_given_at) VALUES (?, ?, ?)",
        args: [guildId, giverId, now],
      });
      if (inserted.rowsAffected === 0) {
        cooldown = await this.client.execute({
          sql: "SELECT last_given_at FROM rep_cooldowns WHERE guild_id = ? AND giver_id = ?",
          args: [guildId, giverId],
        });
        const latestAt = valueAsNumber(cooldown.rows[0]?.last_given_at);
        return { given: false, points: await this.getReputation(guildId, targetId), remainingMs: Math.max(0, cooldownMs - (now - latestAt)) };
      }
    } else {
      const remainingMs = cooldownMs - (now - lastGivenAt);
      if (remainingMs > 0) return { given: false, points: await this.getReputation(guildId, targetId), remainingMs };
      const updated = await this.client.execute({
        sql: "UPDATE rep_cooldowns SET last_given_at = ? WHERE guild_id = ? AND giver_id = ? AND last_given_at = ?",
        args: [now, guildId, giverId, lastGivenAt],
      });
      if (updated.rowsAffected === 0) return { given: false, points: await this.getReputation(guildId, targetId), remainingMs: cooldownMs };
    }
    const result = await this.client.execute({
      sql: `INSERT INTO reputation (guild_id, user_id, points) VALUES (?, ?, 1)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + 1
        RETURNING points`,
      args: [guildId, targetId],
    });
    return { given: true, points: valueAsNumber(result.rows[0]?.points), remainingMs: 0 };
  }

  async getReputation(guildId: string, userId: string): Promise<number> {
    const result = await this.client.execute({
      sql: "SELECT points FROM reputation WHERE guild_id = ? AND user_id = ?",
      args: [guildId, userId],
    });
    return valueAsNumber(result.rows[0]?.points);
  }

  async getReputationLeaderboard(guildId: string): Promise<Array<{ userId: string; points: number }>> {
    const result = await this.client.execute({
      sql: "SELECT user_id, points FROM reputation WHERE guild_id = ? ORDER BY points DESC, user_id ASC LIMIT 10",
      args: [guildId],
    });
    return result.rows.map((row) => ({ userId: valueAsString(row.user_id), points: valueAsNumber(row.points) }));
  }

  async getLeaderboard(guildId: string): Promise<Array<{ userId: string; xp: number }>> {
    const result = await this.client.execute({
      sql: "SELECT user_id, xp FROM member_xp WHERE guild_id = ? ORDER BY xp DESC LIMIT 10",
      args: [guildId],
    });
    return result.rows.map((row) => ({
      userId: valueAsString(row.user_id),
      xp: valueAsNumber(row.xp),
    }));
  }

  async getXp(guildId: string, userId: string): Promise<number> {
    const result = await this.client.execute({
      sql: "SELECT xp FROM member_xp WHERE guild_id = ? AND user_id = ?",
      args: [guildId, userId],
    });
    return valueAsNumber(result.rows[0]?.xp);
  }

  async setXp(guildId: string, userId: string, xp: number): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO member_xp (guild_id, user_id, xp) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp`,
      args: [guildId, userId, xp],
    });
  }

  async setLevelReward(guildId: string, level: number, roleId: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id`,
      args: [guildId, level, roleId],
    });
  }

  async getLevelReward(guildId: string, level: number): Promise<string | undefined> {
    const result = await this.client.execute({
      sql: "SELECT role_id FROM level_rewards WHERE guild_id = ? AND level = ?",
      args: [guildId, level],
    });
    const roleId = valueAsString(result.rows[0]?.role_id);
    return roleId || undefined;
  }

  async setLevelExclusion(guildId: string, type: "channel" | "role", targetId: string, excluded: boolean): Promise<void> {
    await this.client.execute({
      sql: excluded
        ? "INSERT OR IGNORE INTO level_exclusions (guild_id, target_type, target_id) VALUES (?, ?, ?)"
        : "DELETE FROM level_exclusions WHERE guild_id = ? AND target_type = ? AND target_id = ?",
      args: [guildId, type, targetId],
    });
  }

  async isLevelExcluded(guildId: string, channelId: string, roleIds: string[]): Promise<boolean> {
    const roleClause = roleIds.length ? ` OR (target_type = 'role' AND target_id IN (${roleIds.map(() => "?").join(", ")}))` : "";
    const result = await this.client.execute({
      sql: `SELECT 1 FROM level_exclusions WHERE guild_id = ? AND (
        (target_type = 'channel' AND target_id = ?)${roleClause}
      ) LIMIT 1`,
      args: [guildId, channelId, ...roleIds],
    });
    return result.rows.length > 0;
  }

  async recordMessage(guildId: string, userId: string, wordCount: number, isCommand: boolean): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.client.batch([
      {
        sql: `INSERT INTO guild_daily_activity (guild_id, day, messages) VALUES (?, ?, 1)
          ON CONFLICT(guild_id, day) DO UPDATE SET messages = messages + 1`,
        args: [guildId, day],
      },
      {
        sql: `INSERT INTO member_daily_activity (guild_id, user_id, day, messages) VALUES (?, ?, ?, 1)
          ON CONFLICT(guild_id, user_id, day) DO UPDATE SET messages = messages + 1`,
        args: [guildId, userId, day],
      },
      {
        sql: `INSERT INTO member_metrics (guild_id, user_id, words_sent, commands_used) VALUES (?, ?, ?, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET
            words_sent = words_sent + excluded.words_sent,
            commands_used = commands_used + excluded.commands_used`,
        args: [guildId, userId, wordCount, isCommand ? 1 : 0],
      },
    ], "write");
  }

  async recordMemberChange(guildId: string, change: "joins" | "leaves"): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.client.execute({
      sql: `INSERT INTO guild_daily_activity (guild_id, day, ${change}) VALUES (?, ?, 1)
        ON CONFLICT(guild_id, day) DO UPDATE SET ${change} = ${change} + 1`,
      args: [guildId, day],
    });
  }

  async recordVoiceMinutes(guildId: string, userId: string, minutes: number): Promise<void> {
    if (minutes < 1) return;
    const day = new Date().toISOString().slice(0, 10);
    await this.client.batch([
      {
        sql: `INSERT INTO guild_daily_activity (guild_id, day, voice_minutes) VALUES (?, ?, ?)
          ON CONFLICT(guild_id, day) DO UPDATE SET voice_minutes = voice_minutes + excluded.voice_minutes`,
        args: [guildId, day, minutes],
      },
      {
        sql: `INSERT INTO member_metrics (guild_id, user_id, voice_minutes) VALUES (?, ?, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET voice_minutes = voice_minutes + excluded.voice_minutes`,
        args: [guildId, userId, minutes],
      },
    ], "write");
  }

  async setMemberBio(guildId: string, userId: string, bio: string | null): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO member_metrics (guild_id, user_id, bio) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET bio = excluded.bio`,
      args: [guildId, userId, bio],
    });
  }

  async getMemberMetrics(guildId: string, userId: string): Promise<{ wordsSent: number; commandsUsed: number; voiceMinutes: number; bio: string | null }> {
    const result = await this.client.execute({
      sql: "SELECT words_sent, commands_used, voice_minutes, bio FROM member_metrics WHERE guild_id = ? AND user_id = ?",
      args: [guildId, userId],
    });
    const row = result.rows[0];
    return {
      wordsSent: valueAsNumber(row?.words_sent),
      commandsUsed: valueAsNumber(row?.commands_used),
      voiceMinutes: valueAsNumber(row?.voice_minutes),
      bio: typeof row?.bio === "string" ? row.bio : null,
    };
  }

  async getActivitySummary(guildId: string): Promise<ActivitySummary> {
    const since = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [totals, members, daily] = await Promise.all([
      this.client.execute({
        sql: `SELECT SUM(messages) AS messages, SUM(joins) AS joins, SUM(leaves) AS leaves,
          SUM(voice_minutes) AS voice_minutes FROM guild_daily_activity WHERE guild_id = ? AND day >= ?`,
        args: [guildId, since],
      }),
      this.client.execute({
        sql: `SELECT user_id, SUM(messages) AS messages FROM member_daily_activity
          WHERE guild_id = ? AND day >= ? GROUP BY user_id ORDER BY messages DESC LIMIT 5`,
        args: [guildId, since],
      }),
      this.client.execute({
        sql: "SELECT day, messages FROM guild_daily_activity WHERE guild_id = ? AND day >= ? ORDER BY day DESC LIMIT 7",
        args: [guildId, since],
      }),
    ]);
    const total = totals.rows[0];
    return {
      messages: valueAsNumber(total?.messages),
      joins: valueAsNumber(total?.joins),
      leaves: valueAsNumber(total?.leaves),
      voiceMinutes: valueAsNumber(total?.voice_minutes),
      topMembers: members.rows.map((row) => ({
        userId: valueAsString(row.user_id),
        messages: valueAsNumber(row.messages),
      })),
      dailyMessages: daily.rows.map((row) => ({
        day: valueAsString(row.day),
        messages: valueAsNumber(row.messages),
      })).reverse(),
    };
  }

  async pruneActivity(): Promise<void> {
    const since = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await this.client.batch([
      { sql: "DELETE FROM guild_daily_activity WHERE day < ?", args: [since] },
      { sql: "DELETE FROM member_daily_activity WHERE day < ?", args: [since] },
    ], "write");
  }

  async addAlert(guildId: string, platform: AlertPlatform, sourceKey: string): Promise<void> {
    await this.client.execute({
      sql: "INSERT INTO alert_sources (guild_id, platform, source_key) VALUES (?, ?, ?)",
      args: [guildId, platform, sourceKey],
    });
  }

  async removeAlert(guildId: string, id: number): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM alert_sources WHERE guild_id = ? AND id = ?", args: [guildId, id] });
  }

  async getAlerts(guildId?: string): Promise<AlertSource[]> {
    const result = guildId
      ? await this.client.execute({ sql: "SELECT * FROM alert_sources WHERE guild_id = ?", args: [guildId] })
      : await this.client.execute("SELECT * FROM alert_sources");
    return result.rows.map((row) => ({
      id: valueAsNumber(row.id),
      guild_id: valueAsString(row.guild_id),
      platform: valueAsString(row.platform) as AlertPlatform,
      source_key: valueAsString(row.source_key),
      last_event: valueAsString(row.last_event),
      last_live: valueAsNumber(row.last_live),
    }));
  }

  async updateAlert(source: AlertSource, event: string, live: boolean): Promise<void> {
    await this.client.execute({
      sql: "UPDATE alert_sources SET last_event = ?, last_live = ? WHERE id = ?",
      args: [event, live ? 1 : 0, source.id],
    });
  }

  async addTicket(channelId: string, guildId: string, userId: string): Promise<void> {
    await this.client.execute({
      sql: "INSERT INTO tickets (channel_id, guild_id, user_id) VALUES (?, ?, ?)",
      args: [channelId, guildId, userId],
    });
  }

  async getTicket(channelId: string): Promise<{ guildId: string; userId: string } | undefined> {
    const result = await this.client.execute({ sql: "SELECT * FROM tickets WHERE channel_id = ?", args: [channelId] });
    const row = result.rows[0];
    return row
      ? { guildId: valueAsString(row.guild_id), userId: valueAsString(row.user_id) }
      : undefined;
  }

  async removeTicket(channelId: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM tickets WHERE channel_id = ?", args: [channelId] });
  }

  async setAfk(guildId: string, userId: string, reason: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO afk_status (guild_id, user_id, reason, started_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, started_at = excluded.started_at`,
      args: [guildId, userId, reason, Date.now()],
    });
  }

  async getAfk(guildId: string, userId: string): Promise<{ reason: string; startedAt: number } | undefined> {
    const result = await this.client.execute({
      sql: "SELECT reason, started_at FROM afk_status WHERE guild_id = ? AND user_id = ?",
      args: [guildId, userId],
    });
    const row = result.rows[0];
    return row
      ? { reason: valueAsString(row.reason), startedAt: valueAsNumber(row.started_at) }
      : undefined;
  }

  async getAfkStatuses(guildId: string, userIds: string[]): Promise<Array<{ userId: string; reason: string; startedAt: number }>> {
    if (!userIds.length) return [];
    const result = await this.client.execute({
      sql: `SELECT user_id, reason, started_at FROM afk_status WHERE guild_id = ? AND user_id IN (${userIds.map(() => "?").join(", ")})`,
      args: [guildId, ...userIds],
    });
    return result.rows.map((row) => ({
      userId: valueAsString(row.user_id),
      reason: valueAsString(row.reason),
      startedAt: valueAsNumber(row.started_at),
    }));
  }

  async removeAfk(guildId: string, userId: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM afk_status WHERE guild_id = ? AND user_id = ?", args: [guildId, userId] });
  }

  async createGiveaway(giveaway: Omit<Giveaway, "status" | "winnerIds">): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO giveaways (message_id, guild_id, channel_id, host_id, prize, ends_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [giveaway.messageId, giveaway.guildId, giveaway.channelId, giveaway.hostId, giveaway.prize, giveaway.endsAt],
    });
  }

  async getGiveaway(messageId: string): Promise<Giveaway | undefined> {
    const result = await this.client.execute({ sql: "SELECT * FROM giveaways WHERE message_id = ?", args: [messageId] });
    const row = result.rows[0];
    if (!row) return undefined;
    let winnerIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(valueAsString(row.winner_ids));
      if (Array.isArray(parsed)) winnerIds = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      winnerIds = [];
    }
    return {
      messageId: valueAsString(row.message_id),
      guildId: valueAsString(row.guild_id),
      channelId: valueAsString(row.channel_id),
      hostId: valueAsString(row.host_id),
      prize: valueAsString(row.prize),
      endsAt: valueAsNumber(row.ends_at),
      status: valueAsString(row.status) === "ended" ? "ended" : "active",
      winnerIds,
    };
  }

  async getDueGiveaways(now: number): Promise<Giveaway[]> {
    const result = await this.client.execute({
      sql: "SELECT message_id FROM giveaways WHERE status = 'active' AND ends_at <= ?",
      args: [now],
    });
    const giveaways = await Promise.all(result.rows.map((row) => this.getGiveaway(valueAsString(row.message_id))));
    return giveaways.filter((giveaway): giveaway is Giveaway => giveaway !== undefined);
  }

  async addGiveawayEntry(messageId: string, userId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "INSERT OR IGNORE INTO giveaway_entries (giveaway_message_id, user_id) VALUES (?, ?)",
      args: [messageId, userId],
    });
    return result.rowsAffected > 0;
  }

  async getGiveawayEntries(messageId: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: "SELECT user_id FROM giveaway_entries WHERE giveaway_message_id = ?",
      args: [messageId],
    });
    return result.rows.map((row) => valueAsString(row.user_id));
  }

  async finishGiveaway(messageId: string, winnerIds: string[]): Promise<boolean> {
    const result = await this.client.execute({
      sql: "UPDATE giveaways SET status = 'ended', winner_ids = ? WHERE message_id = ? AND status = 'active'",
      args: [JSON.stringify(winnerIds), messageId],
    });
    return result.rowsAffected > 0;
  }

  async updateGiveawayWinners(messageId: string, winnerIds: string[]): Promise<void> {
    await this.client.execute({
      sql: "UPDATE giveaways SET winner_ids = ? WHERE message_id = ? AND status = 'ended'",
      args: [JSON.stringify(winnerIds), messageId],
    });
  }

  async getLatestEndedGiveaway(channelId: string): Promise<Giveaway | undefined> {
    const result = await this.client.execute({
      sql: "SELECT message_id FROM giveaways WHERE channel_id = ? AND status = 'ended' ORDER BY ends_at DESC LIMIT 1",
      args: [channelId],
    });
    const messageId = valueAsString(result.rows[0]?.message_id);
    return messageId ? this.getGiveaway(messageId) : undefined;
  }

  async close(): Promise<void> {
    this.client.close();
  }
}