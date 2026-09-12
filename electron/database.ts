import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { app } from "electron";
import type {
  Account,
  AccountCreateInput,
  AccountRuntimeStatus,
  AccountUpdateInput,
  ApiUser,
  ApiUserCreateInput,
  ApiRequest,
  ApiRequestCreateInput,
  ApiRequestStatus,
  ApiRequestUpdateInput,
  AppSettings,
  AppSettingsUpdateInput,
  CreditLedgerEntry,
  DolaModel,
  OperationLog,
  OperationLogCreateInput
} from "./types.js";

const now = () => new Date().toISOString();
const OPERATION_LOG_RETENTION_DAYS = 3;

const DEFAULT_SETTINGS: AppSettings = {
  apiServiceEnabled: true,
  apiPort: 17888,
  apiKey: `dola-admin-${randomBytes(24).toString("base64url")}`,
  executorEnabled: true,
  showExecutorWindow: false,
  autoCloseExecutorWindow: true,
  dolaChatUrl: "https://www.dola.com/chat",
  defaultModel: "seedance_2_5",
  dailyQuotaLimit: 4,
  seedance20Cost: 2,
  seedance25Cost: 2,
  dailyResetTime: "00:00",
  generationTimeoutSeconds: 900,
  maxConcurrentAccounts: 4,
  retryCount: 1,
  autoRemoveWatermark: true,
  watermarkApiUrl: "https://nologo.code24.top/api/water-mask/parse",
  watermarkApiToken: "",
  outputDir: ""
};

export class AppDatabase {
  private readonly db: Database.Database;

  constructor() {
    const dbPath = path.join(app.getPath("userData"), "dola-manager.sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        partition TEXT NOT NULL UNIQUE,
        remark TEXT NOT NULL DEFAULT '',
        login_status TEXT NOT NULL DEFAULT 'unknown',
        current_status TEXT NOT NULL DEFAULT 'idle',
        daily_quota_limit INTEGER NOT NULL DEFAULT 4,
        quota_remaining INTEGER NOT NULL DEFAULT 4,
        quota_used_today INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        credits INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES api_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        type TEXT NOT NULL,
        request_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES api_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT 'local',
        model TEXT NOT NULL,
        account_id INTEGER,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        reference_image_path TEXT,
        reference_image_paths TEXT,
        user_id INTEGER,
        credit_cost INTEGER NOT NULL DEFAULT 0,
        credit_refunded INTEGER NOT NULL DEFAULT 0,
        remove_watermark INTEGER NOT NULL DEFAULT 1,
        callback_url TEXT,
        dola_thread_url TEXT,
        raw_video_url TEXT,
        clean_video_url TEXT,
        output_video_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL,
        FOREIGN KEY(user_id) REFERENCES api_users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        account_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL DEFAULT '',
        target_url TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_operation_logs_request_id ON operation_logs(request_id);
      CREATE INDEX IF NOT EXISTS idx_api_sessions_token_hash ON api_sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger(user_id, id DESC);
    `);

    this.ensureAccountColumns();
    this.ensureApiRequestColumns();
    this.pruneOperationLogs();
    this.cleanInvalidSuccessfulResults();
    this.ensureDefaultSettings();
    this.rotateInsecureDefaultApiKey();
    this.migrateExecutorConcurrency();
  }

  listAccounts(): Account[] {
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      ORDER BY id ASC
    `).all() as Account[];
  }

  getAccount(id: number): Account | undefined {
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      WHERE id = ?
    `).get(id) as Account | undefined;
  }

  createAccount(input: AccountCreateInput = {}): Account {
    const timestamp = now();
    const settings = this.getSettings();
    const nextNumber = this.nextAccountNumber();
    const name = `账号 ${String(nextNumber).padStart(3, "0")}`;
    const partition = `persist:dola_account_${String(nextNumber).padStart(3, "0")}`;

    const result = this.db.prepare(`
      INSERT INTO accounts (
        name,
        partition,
        remark,
        login_status,
        current_status,
        daily_quota_limit,
        quota_remaining,
        quota_used_today,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 'unknown', 'login_required', ?, ?, 0, ?, ?)
    `).run(
      name,
      partition,
      input.remark?.trim() || "",
      settings.dailyQuotaLimit,
      settings.dailyQuotaLimit,
      timestamp,
      timestamp
    );

    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  updateAccount(input: AccountUpdateInput): Account {
    const existing = this.getAccount(input.id);
    if (!existing) throw new Error("Account not found");

    const updated = {
      remark: input.remark ?? existing.remark,
      loginStatus: input.loginStatus ?? existing.loginStatus,
      currentStatus: input.currentStatus ?? existing.currentStatus,
      dailyQuotaLimit: input.dailyQuotaLimit ?? existing.dailyQuotaLimit,
      quotaRemaining: input.quotaRemaining ?? existing.quotaRemaining,
      quotaUsedToday: input.quotaUsedToday ?? existing.quotaUsedToday,
      updatedAt: now()
    };

    this.db.prepare(`
      UPDATE accounts
      SET
        remark = ?,
        login_status = ?,
        current_status = ?,
        daily_quota_limit = ?,
        quota_remaining = ?,
        quota_used_today = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updated.remark.trim(),
      updated.loginStatus,
      updated.currentStatus,
      clampInt(updated.dailyQuotaLimit),
      clampInt(updated.quotaRemaining),
      clampInt(updated.quotaUsedToday),
      updated.updatedAt,
      input.id
    );

    return this.getAccount(input.id)!;
  }

  deleteAccount(id: number) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  resetAccountQuota(id: number): Account {
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    return this.getAccount(id)!;
  }

  resetAllQuotas(): Account[] {
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        updated_at = ?
    `).run(now());
    return this.listAccounts();
  }

  findAvailableAccount(model: DolaModel): Account | undefined {
    const settings = this.getSettings();
    const requiredQuota = model === "seedance_2_0" ? settings.seedance20Cost : settings.seedance25Cost;
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      WHERE login_status = 'logged_in'
        AND current_status IN ('idle', 'error')
        AND quota_remaining >= ?
      ORDER BY
        CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END ASC,
        last_used_at ASC,
        id ASC
      LIMIT 1
    `).get(requiredQuota) as Account | undefined;
  }

  reserveAvailableAccount(model: DolaModel): Account | undefined {
    return this.db.transaction(() => {
      const account = this.findAvailableAccount(model);
      if (!account) return undefined;
      this.markAccountAllocated(account.id, "busy");
      return this.getAccount(account.id);
    })();
  }

  deductQuota(accountId: number, model: DolaModel): Account {
    const settings = this.getSettings();
    const cost = model === "seedance_2_0" ? settings.seedance20Cost : settings.seedance25Cost;
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MAX(0, quota_remaining - ?),
          quota_used_today = quota_used_today + ?,
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, timestamp, accountId);
    return this.getAccount(accountId)!;
  }

  refundQuota(accountId: number, model: DolaModel): Account {
    const settings = this.getSettings();
    const cost = model === "seedance_2_0" ? settings.seedance20Cost : settings.seedance25Cost;
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MIN(daily_quota_limit, quota_remaining + ?),
          quota_used_today = MAX(0, quota_used_today - ?),
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, accountId);
    return this.getAccount(accountId)!;
  }

  markAccountAllocated(id: number, status: AccountRuntimeStatus = "idle") {
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET current_status = ?,
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, timestamp, timestamp, id);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const data = { ...DEFAULT_SETTINGS } as Record<keyof AppSettings, unknown>;
    for (const row of rows) {
      if (isSettingsKey(row.key)) {
        data[row.key] = parseSettingValue(row.key, row.value);
      }
    }
    return data as AppSettings;
  }

  updateSettings(input: AppSettingsUpdateInput): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      ...input,
      apiPort: clampPort(input.apiPort ?? current.apiPort),
      executorEnabled: Boolean(input.executorEnabled ?? current.executorEnabled),
      showExecutorWindow: Boolean(input.showExecutorWindow ?? current.showExecutorWindow),
      autoCloseExecutorWindow: Boolean(input.autoCloseExecutorWindow ?? current.autoCloseExecutorWindow),
      dolaChatUrl: String(input.dolaChatUrl || current.dolaChatUrl || DEFAULT_SETTINGS.dolaChatUrl),
      defaultModel: "seedance_2_5",
      dailyQuotaLimit: clampInt(input.dailyQuotaLimit ?? current.dailyQuotaLimit),
      seedance20Cost: Math.max(1, clampInt(input.seedance20Cost ?? current.seedance20Cost)),
      seedance25Cost: 2,
      generationTimeoutSeconds: clampInt(input.generationTimeoutSeconds ?? current.generationTimeoutSeconds),
      maxConcurrentAccounts: Math.max(1, clampInt(input.maxConcurrentAccounts ?? current.maxConcurrentAccounts)),
      retryCount: clampInt(input.retryCount ?? current.retryCount)
    };

    const timestamp = now();
    const statement = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      const value = next[key];
      statement.run(key, stringifySettingValue(value), timestamp);
    }

    return this.getSettings();
  }

  listApiUsers(): ApiUser[] {
    return this.db.prepare(`
      SELECT id, username, role, credits, disabled, created_at AS createdAt, updated_at AS updatedAt
      FROM api_users
      ORDER BY id DESC
    `).all().map(normalizeApiUser);
  }

  getApiUser(id: number): ApiUser | undefined {
    const row = this.db.prepare(`
      SELECT id, username, role, credits, disabled, created_at AS createdAt, updated_at AS updatedAt
      FROM api_users WHERE id = ?
    `).get(id);
    return row ? normalizeApiUser(row) : undefined;
  }

  getApiUserAuthByUsername(username: string) {
    return this.db.prepare(`
      SELECT id, username, role, credits, disabled, password_hash AS passwordHash,
        password_salt AS passwordSalt, created_at AS createdAt, updated_at AS updatedAt
      FROM api_users WHERE username = ? COLLATE NOCASE
    `).get(username) as (ApiUser & { passwordHash: string; passwordSalt: string; disabled: number | boolean }) | undefined;
  }

  createApiUser(
    input: ApiUserCreateInput,
    passwordHash: string,
    passwordSalt: string
  ): ApiUser {
    const timestamp = now();
    const initialCredits = Math.max(0, Math.trunc(input.initialCredits || 0));
    const result = this.db.prepare(`
      INSERT INTO api_users (username, password_hash, password_salt, role, credits, disabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.username.trim(),
      passwordHash,
      passwordSalt,
      input.role === "admin" ? "admin" : "user",
      initialCredits,
      timestamp,
      timestamp
    );
    const userId = Number(result.lastInsertRowid);
    if (initialCredits > 0) {
      this.db.prepare(`
        INSERT INTO credit_ledger (user_id, amount, balance_after, type, request_id, note, created_at)
        VALUES (?, ?, ?, 'grant', NULL, '创建用户初始积分', ?)
      `).run(userId, initialCredits, initialCredits, timestamp);
    }
    return this.getApiUser(userId)!;
  }

  createApiSession(userId: number, tokenHash: string, expiresAt: string) {
    const timestamp = now();
    this.db.prepare("DELETE FROM api_sessions WHERE expires_at <= ?").run(timestamp);
    this.db.prepare(`
      INSERT INTO api_sessions (user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, tokenHash, expiresAt, timestamp);
  }

  getApiUserBySessionHash(tokenHash: string): ApiUser | undefined {
    const row = this.db.prepare(`
      SELECT users.id, users.username, users.role, users.credits, users.disabled,
        users.created_at AS createdAt, users.updated_at AS updatedAt
      FROM api_sessions sessions
      JOIN api_users users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(tokenHash, now());
    return row ? normalizeApiUser(row) : undefined;
  }

  deleteApiSession(tokenHash: string) {
    return this.db.prepare("DELETE FROM api_sessions WHERE token_hash = ?").run(tokenHash).changes > 0;
  }

  setApiUserDisabled(userId: number, disabled: boolean) {
    const result = this.db.prepare("UPDATE api_users SET disabled = ?, updated_at = ? WHERE id = ?")
      .run(disabled ? 1 : 0, now(), userId);
    if (result.changes !== 1) throw new Error("用户不存在");
    if (disabled) this.db.prepare("DELETE FROM api_sessions WHERE user_id = ?").run(userId);
    return this.getApiUser(userId)!;
  }

  grantApiUserCredits(userId: number, amount: number, note = "管理员发放积分") {
    const normalizedAmount = Math.trunc(amount);
    if (!normalizedAmount) throw new Error("积分变动不能为 0");
    return this.db.transaction(() => {
      const user = this.getApiUser(userId);
      if (!user) throw new Error("用户不存在");
      const balanceAfter = user.credits + normalizedAmount;
      if (balanceAfter < 0) throw new Error("扣减后积分不能小于 0");
      const timestamp = now();
      this.db.prepare("UPDATE api_users SET credits = ?, updated_at = ? WHERE id = ?")
        .run(balanceAfter, timestamp, userId);
      this.db.prepare(`
        INSERT INTO credit_ledger (user_id, amount, balance_after, type, request_id, note, created_at)
        VALUES (?, ?, ?, 'grant', NULL, ?, ?)
      `).run(userId, normalizedAmount, balanceAfter, note.trim() || "管理员调整积分", timestamp);
      return this.getApiUser(userId)!;
    })();
  }

  consumeApiUserCredits(userId: number, amount: number, requestId: string) {
    const cost = Math.max(1, Math.trunc(amount));
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE api_users SET credits = credits - ?, updated_at = ?
        WHERE id = ? AND disabled = 0 AND credits >= ?
      `).run(cost, now(), userId, cost);
      if (result.changes !== 1) return false;
      const user = this.getApiUser(userId)!;
      this.db.prepare(`
        INSERT INTO credit_ledger (user_id, amount, balance_after, type, request_id, note, created_at)
        VALUES (?, ?, ?, 'consume', ?, 'Seedance 2.5 视频生成', ?)
      `).run(userId, -cost, user.credits, requestId, now());
      return true;
    })();
  }

  refundApiUserCreditsForRequest(requestId: string) {
    return this.db.transaction(() => {
      const request = this.db.prepare(`
        SELECT user_id AS userId, credit_cost AS creditCost, credit_refunded AS creditRefunded
        FROM api_requests WHERE request_id = ?
      `).get(requestId) as { userId: number | null; creditCost: number; creditRefunded: number } | undefined;
      if (!request?.userId || request.creditCost <= 0 || request.creditRefunded) return false;
      const user = this.getApiUser(request.userId);
      if (!user) return false;
      const timestamp = now();
      const balanceAfter = user.credits + request.creditCost;
      this.db.prepare("UPDATE api_users SET credits = ?, updated_at = ? WHERE id = ?")
        .run(balanceAfter, timestamp, request.userId);
      this.db.prepare("UPDATE api_requests SET credit_refunded = 1 WHERE request_id = ?").run(requestId);
      this.db.prepare(`
        INSERT INTO credit_ledger (user_id, amount, balance_after, type, request_id, note, created_at)
        VALUES (?, ?, ?, 'refund', ?, '任务提交前失败，退回积分', ?)
      `).run(request.userId, request.creditCost, balanceAfter, requestId, timestamp);
      return true;
    })();
  }

  listCreditLedger(userId?: number, limit = 200): CreditLedgerEntry[] {
    const where = userId ? "WHERE ledger.user_id = ?" : "";
    const params = userId ? [userId, limit] : [limit];
    return this.db.prepare(`
      SELECT ledger.id, ledger.user_id AS userId, users.username, ledger.amount,
        ledger.balance_after AS balanceAfter, ledger.type, ledger.request_id AS requestId,
        ledger.note, ledger.created_at AS createdAt
      FROM credit_ledger ledger
      JOIN api_users users ON users.id = ledger.user_id
      ${where}
      ORDER BY ledger.id DESC LIMIT ?
    `).all(...params) as CreditLedgerEntry[];
  }

  listApiRequests(limit = 100, userId?: number): ApiRequest[] {
    const where = userId ? "WHERE api_requests.user_id = ?" : "";
    const params = userId ? [userId, limit] : [limit];
    return this.db.prepare(`
      SELECT
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.reference_image_paths AS referenceImagePathsJson,
        api_requests.user_id AS userId,
        api_users.username,
        api_requests.credit_cost AS creditCost,
        api_requests.credit_refunded AS creditRefunded,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.dola_thread_url AS dolaThreadUrl,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      LEFT JOIN api_users ON api_users.id = api_requests.user_id
      ${where}
      ORDER BY api_requests.id DESC
      LIMIT ?
    `).all(...params).map(normalizeApiRequest);
  }

  getApiRequest(requestId: string): ApiRequest | undefined {
    const row = this.db.prepare(`
      SELECT
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.reference_image_paths AS referenceImagePathsJson,
        api_requests.user_id AS userId,
        api_users.username,
        api_requests.credit_cost AS creditCost,
        api_requests.credit_refunded AS creditRefunded,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.dola_thread_url AS dolaThreadUrl,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      LEFT JOIN api_users ON api_users.id = api_requests.user_id
      WHERE api_requests.request_id = ?
    `).get(requestId);
    return row ? normalizeApiRequest(row) : undefined;
  }

  createApiRequest(input: ApiRequestCreateInput): ApiRequest {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO api_requests (
        request_id,
        source,
        model,
        account_id,
        status,
        message,
        prompt,
        reference_image_path,
        reference_image_paths,
        user_id,
        credit_cost,
        credit_refunded,
        remove_watermark,
        callback_url,
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.source || "local-api",
      input.model,
      input.accountId ?? null,
      input.status,
      input.message || "",
      input.prompt,
      input.referenceImagePath || null,
      JSON.stringify(input.referenceImagePaths || (input.referenceImagePath ? [input.referenceImagePath] : [])),
      input.userId ?? null,
      Math.max(0, Math.trunc(input.creditCost || 0)),
      0,
      input.removeWatermark === false ? 0 : 1,
      input.callbackUrl || null,
      timestamp,
      timestamp,
      input.status === "failed" || input.status === "success" || input.status === "stopped" ? timestamp : null
    );
    return this.getApiRequest(input.requestId)!;
  }

  updateApiRequestStatus(requestId: string, status: ApiRequestStatus, message: string) {
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET status = ?, message = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(status, message, now(), finishedAt, requestId);
    return this.getApiRequest(requestId)!;
  }

  updateApiRequest(input: ApiRequestUpdateInput) {
    const existing = this.getApiRequest(input.requestId);
    if (!existing) throw new Error("Request not found");

    const status = input.status ?? existing.status;
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = ?,
        message = ?,
        dola_thread_url = ?,
        raw_video_url = ?,
        clean_video_url = ?,
        output_video_path = ?,
        updated_at = ?,
        finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(
      status,
      input.message ?? existing.message,
      input.dolaThreadUrl ?? existing.dolaThreadUrl,
      input.rawVideoUrl ?? existing.rawVideoUrl,
      input.cleanVideoUrl ?? existing.cleanVideoUrl,
      input.outputVideoPath ?? existing.outputVideoPath,
      now(),
      finishedAt,
      input.requestId
    );
    return this.getApiRequest(input.requestId)!;
  }

  clearApiRequests() {
    this.db.prepare("DELETE FROM api_requests").run();
  }

  appendOperationLog(input: OperationLogCreateInput): OperationLog {
    this.pruneOperationLogs();
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO operation_logs (
        request_id,
        account_id,
        action,
        status,
        message,
        target_url,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId || null,
      input.accountId ?? null,
      input.action,
      input.status || "info",
      input.message,
      input.targetUrl || null,
      timestamp
    );
    return this.getOperationLog(Number(result.lastInsertRowid))!;
  }

  listOperationLogs(limit = 500): OperationLog[] {
    this.pruneOperationLogs();
    return this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      ORDER BY operation_logs.id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(2000, limit))).map(normalizeOperationLog);
  }

  getOperationLog(id: number): OperationLog | undefined {
    const row = this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      WHERE operation_logs.id = ?
    `).get(id);
    return row ? normalizeOperationLog(row) : undefined;
  }

  clearOperationLogs() {
    this.db.prepare("DELETE FROM operation_logs").run();
  }

  private pruneOperationLogs() {
    const cutoff = new Date(Date.now() - OPERATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM operation_logs WHERE created_at < ?").run(cutoff);
  }

  private ensureDefaultSettings() {
    const existingCount = this.db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
    if (existingCount.count === 0) {
      this.updateSettings(DEFAULT_SETTINGS);
    }
  }

  private rotateInsecureDefaultApiKey() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'apiKey'").get() as { value?: string } | undefined;
    const value = row?.value ? String(parseSettingValue("apiKey", row.value)) : "";
    if (value && value !== "local-dola-key") return;
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('apiKey', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(stringifySettingValue(DEFAULT_SETTINGS.apiKey), now());
  }

  private migrateExecutorConcurrency() {
    const migrationKey = "executorConcurrencyV1";
    const migrated = this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(migrationKey);
    if (migrated) return;

    const timestamp = now();
    this.db.prepare(`
      UPDATE settings
      SET value = '4', updated_at = ?
      WHERE key = 'maxConcurrentAccounts' AND CAST(value AS INTEGER) = 1
    `).run(timestamp);
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', ?)")
      .run(migrationKey, timestamp);
  }

  private ensureAccountColumns() {
    this.addColumnIfMissing("accounts", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "remark", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "current_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.addColumnIfMissing("accounts", "daily_quota_limit", "INTEGER NOT NULL DEFAULT 4");
    this.addColumnIfMissing("accounts", "quota_remaining", "INTEGER NOT NULL DEFAULT 4");
    this.addColumnIfMissing("accounts", "quota_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "mini_daily_limit", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_remaining", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "fast_daily_limit", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_remaining", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_used_today", "INTEGER NOT NULL DEFAULT 0");

    this.db.prepare(`
      UPDATE accounts
      SET
        name = CASE WHEN name = '' THEN '账号 ' || printf('%03d', id) ELSE name END,
        remark = CASE WHEN remark = '' AND name NOT LIKE '账号 %' THEN name ELSE remark END
    `).run();
  }

  private ensureApiRequestColumns() {
    this.addColumnIfMissing("api_requests", "source", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("api_requests", "reference_image_path", "TEXT");
    this.addColumnIfMissing("api_requests", "reference_image_paths", "TEXT");
    this.addColumnIfMissing("api_requests", "user_id", "INTEGER");
    this.addColumnIfMissing("api_requests", "credit_cost", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "credit_refunded", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "remove_watermark", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("api_requests", "callback_url", "TEXT");
    this.addColumnIfMissing("api_requests", "dola_thread_url", "TEXT");
    this.addColumnIfMissing("api_requests", "raw_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "clean_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "output_video_path", "TEXT");
    this.addColumnIfMissing("api_requests", "finished_at", "TEXT");
  }

  private cleanInvalidSuccessfulResults() {
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = 'failed',
        message = '历史结果不包含有效的去水印 MP4',
        raw_video_url = NULL,
        clean_video_url = NULL,
        output_video_path = NULL,
        updated_at = ?,
        finished_at = COALESCE(finished_at, ?)
      WHERE status = 'success'
        AND NOT (
          LOWER(COALESCE(clean_video_url, '')) LIKE '%.mp4%'
          OR LOWER(COALESCE(clean_video_url, '')) LIKE '%video_mp4%'
          OR LOWER(COALESCE(output_video_path, '')) LIKE '%.mp4'
        )
    `).run(now(), now());
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  private nextAccountNumber(): number {
    const rows = this.db.prepare("SELECT partition FROM accounts").all() as Array<{ partition: string }>;
    const used = rows
      .map((row) => row.partition.match(/^persist:dola_account_(\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));

    let current = 1;
    while (used.includes(current)) current += 1;
    return current;
  }
}

function clampInt(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampPort(value: number) {
  const port = clampInt(value);
  if (port < 1 || port > 65535) return DEFAULT_SETTINGS.apiPort;
  return port;
}

function stringifySettingValue(value: unknown) {
  return JSON.stringify(value);
}

function parseSettingValue(key: keyof AppSettings, value: string) {
  try {
    return JSON.parse(value) as AppSettings[typeof key];
  } catch {
    return value;
  }
}

function isSettingsKey(key: string): key is keyof AppSettings {
  return key in DEFAULT_SETTINGS;
}

function normalizeApiRequest(row: unknown): ApiRequest {
  const request = row as ApiRequest & { removeWatermark: number | boolean; referenceImagePathsJson?: string | null };
  let referenceImagePaths: string[] = [];
  try {
    const parsed = JSON.parse(request.referenceImagePathsJson || "[]");
    if (Array.isArray(parsed)) referenceImagePaths = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    referenceImagePaths = [];
  }
  if (!referenceImagePaths.length && request.referenceImagePath) referenceImagePaths = [request.referenceImagePath];
  return {
    ...request,
    referenceImagePaths,
    userId: request.userId == null ? null : Number(request.userId),
    username: request.username || null,
    creditCost: Number(request.creditCost || 0),
    creditRefunded: Boolean(request.creditRefunded),
    removeWatermark: Boolean(request.removeWatermark)
  };
}

function normalizeApiUser(row: unknown): ApiUser {
  const user = row as ApiUser & { disabled: number | boolean };
  return {
    ...user,
    id: Number(user.id),
    credits: Number(user.credits || 0),
    disabled: Boolean(user.disabled),
    role: user.role === "admin" ? "admin" : "user"
  };
}

function normalizeOperationLog(row: unknown): OperationLog {
  const log = row as OperationLog & { accountId: number | null };
  return {
    ...log,
    requestId: log.requestId || null,
    accountId: log.accountId === null || log.accountId === undefined ? null : Number(log.accountId),
    accountName: log.accountName || null,
    accountPartition: log.accountPartition || null,
    status: log.status === "success" || log.status === "failed" ? log.status : "info",
    targetUrl: log.targetUrl || null
  };
}
