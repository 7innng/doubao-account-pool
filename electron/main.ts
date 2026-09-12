import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session } from "electron";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DolaExecutor } from "./executor.js";
import { ensureDolaExtension } from "./extension-loader.js";
import { toPublicApiRequest } from "./public-api.js";
import type {
  AccountUpdateInput,
  ApiUser,
  ApiUserCreateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DolaModel,
  GenerateRequestBody
} from "./types.js";
import { resolveCleanVideoUrl } from "./watermark.js";
import { TcpApiServer } from "./tcp-api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;
let executor: DolaExecutor;
let apiServer: LocalApiServer;
let tcpApiServer: TcpApiServer;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const USER_SESSION_DAYS = 30;
const USER_GENERATION_CREDIT_COST = 2;

type ApiPrincipal =
  | { kind: "service" }
  | { kind: "user"; user: ApiUser };

class LocalApiServer {
  private server: Server | null = null;
  private status: ApiServerStatus = {
    version: app.getVersion(),
    enabled: false,
    running: false,
    port: 0,
    url: null,
    message: "未启动"
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly requestExecutor: DolaExecutor
  ) {}

  async applySettings(settings: AppSettings) {
    await this.stop();

    this.status = {
      version: app.getVersion(),
      enabled: settings.apiServiceEnabled,
      running: false,
      port: settings.apiPort,
      url: null,
      message: settings.apiServiceEnabled ? "启动中" : "已关闭"
    };

    if (!settings.apiServiceEnabled) return this.status;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: false,
          port: settings.apiPort,
          url: null,
          message: `启动失败：${error.message}`
        };
        resolve();
      });

      this.server!.listen(settings.apiPort, "127.0.0.1", () => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: true,
          port: settings.apiPort,
          url: `http://127.0.0.1:${settings.apiPort}`,
          message: "运行中"
        };
        resolve();
      });
    });

    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const settings = this.database.getSettings();

    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "dola-account-pool",
          api: this.getStatus()
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/auth/register") {
        const body = await readJsonBody<{ username?: string; password?: string }>(request);
        const credentials = validateCredentials(body.username, body.password);
        if (this.database.getApiUserAuthByUsername(credentials.username)) {
          sendJson(response, 409, { error: "用户名已存在" });
          return;
        }
        const password = hashPassword(credentials.password);
        const user = this.database.createApiUser(
          { username: credentials.username, password: "", role: "user", initialCredits: 0 },
          password.hash,
          password.salt
        );
        const accessToken = issueUserSession(this.database, user.id);
        sendJson(response, 201, { accessToken, user: toPublicUser(user) });
        notifyDataChanged();
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
        const body = await readJsonBody<{ username?: string; password?: string }>(request);
        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        const userAuth = this.database.getApiUserAuthByUsername(username);
        if (!userAuth || Boolean(userAuth.disabled) || !verifyPassword(password, userAuth.passwordSalt, userAuth.passwordHash)) {
          sendJson(response, 401, { error: "用户名或密码错误" });
          return;
        }
        const user = this.database.getApiUser(userAuth.id)!;
        const accessToken = issueUserSession(this.database, user.id);
        sendJson(response, 200, { accessToken, user: toPublicUser(user) });
        return;
      }

      const principal = authenticateRequest(request, settings.apiKey, this.database);
      if (!principal) {
        sendJson(response, 401, { error: "请先登录或提供有效的 API Token" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/me") {
        if (principal.kind !== "user") {
          sendJson(response, 400, { error: "服务端 API Key 没有个人积分账户" });
          return;
        }
        sendJson(response, 200, { user: toPublicUser(this.database.getApiUser(principal.user.id)!) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
        const token = bearerToken(request);
        if (principal.kind === "user" && token) this.database.deleteApiSession(hashToken(token));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/me/credits") {
        if (principal.kind !== "user") {
          sendJson(response, 400, { error: "服务端 API Key 没有个人积分流水" });
          return;
        }
        sendJson(response, 200, {
          user: toPublicUser(this.database.getApiUser(principal.user.id)!),
          ledger: this.database.listCreditLedger(principal.user.id, 200)
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/me/requests") {
        if (principal.kind !== "user") {
          sendJson(response, 400, { error: "服务端 API Key 没有个人任务列表" });
          return;
        }
        const limit = Math.min(100, Math.max(1, Math.trunc(Number(requestUrl.searchParams.get("limit")) || 20)));
        sendJson(response, 200, {
          requests: this.database.listApiRequests(limit, principal.user.id).map(toPublicApiRequest)
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        sendJson(response, 200, { accounts: this.database.listAccounts() });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/admin/users") {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        sendJson(response, 200, { users: this.database.listApiUsers() });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/admin/users") {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        const body = await readJsonBody<ApiUserCreateInput>(request);
        const credentials = validateCredentials(body.username, body.password);
        if (this.database.getApiUserAuthByUsername(credentials.username)) {
          sendJson(response, 409, { error: "用户名已存在" });
          return;
        }
        const password = hashPassword(credentials.password);
        const user = this.database.createApiUser(
          {
            username: credentials.username,
            password: "",
            role: body.role === "admin" ? "admin" : "user",
            initialCredits: Math.max(0, Math.trunc(Number(body.initialCredits) || 0))
          },
          password.hash,
          password.salt
        );
        notifyDataChanged();
        sendJson(response, 201, { user: toPublicUser(user) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/admin/credits/grant") {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        const body = await readJsonBody<{ userId?: number; amount?: number; note?: string }>(request);
        const userId = Math.trunc(Number(body.userId));
        const amount = Math.trunc(Number(body.amount));
        if (!userId || !amount) {
          sendJson(response, 400, { error: "userId 和非零 amount 为必填项" });
          return;
        }
        const user = this.database.grantApiUserCredits(userId, amount, String(body.note || "管理员发放积分"));
        notifyDataChanged();
        sendJson(response, 200, { user: toPublicUser(user) });
        return;
      }

      const disableUserMatch = requestUrl.pathname.match(/^\/api\/admin\/users\/(\d+)\/disabled$/);
      if (request.method === "POST" && disableUserMatch) {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        const body = await readJsonBody<{ disabled?: boolean }>(request);
        const user = this.database.setApiUserDisabled(Number(disableUserMatch[1]), Boolean(body.disabled));
        notifyDataChanged();
        sendJson(response, 200, { user: toPublicUser(user) });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/admin/credits") {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        sendJson(response, 200, { ledger: this.database.listCreditLedger(undefined, 500) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate") {
        const requestId = `dola-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const body = await readGenerateRequest(request, requestId);
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const model = normalizeModel(body.model || "seedance_2_5");
        if (!model) {
          sendJson(response, 400, { error: "unsupported model" });
          return;
        }

        const referenceImagePaths = await prepareReferenceImages(body, requestId);
        const referenceImagePath = referenceImagePaths[0] || null;
        const account = settings.executorEnabled
          ? this.database.reserveAvailableAccount(model)
          : this.database.findAvailableAccount(model);
        const cost = settings.seedance25Cost;
        const apiUserId = principal.kind === "user" ? principal.user.id : null;

        if (!account) {
          const failed = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            status: "failed",
            message: "没有可用账号，或该模型剩余额度不足",
            prompt,
            referenceImagePath,
            referenceImagePaths,
            userId: apiUserId,
            creditCost: 0,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
          this.database.appendOperationLog({
            requestId,
            action: "分配账号",
            status: "failed",
            message: failed.message
          });
          notifyDataChanged();
          void postCallback(failed);
          sendJson(response, 409, toPublicApiRequest(failed));
          return;
        }

        let userCreditsCharged = false;
        if (apiUserId && !this.database.consumeApiUserCredits(apiUserId, USER_GENERATION_CREDIT_COST, requestId)) {
          this.database.updateAccount({ id: account.id, currentStatus: "idle" });
          sendJson(response, 402, {
            error: `积分不足，Seedance 2.5 每次需要 ${USER_GENERATION_CREDIT_COST} 积分`,
            user: toPublicUser(this.database.getApiUser(apiUserId)!)
          });
          return;
        }
        userCreditsCharged = Boolean(apiUserId);

        let accountQuotaCharged = false;
        let created: ApiRequest;
        try {
          this.database.deductQuota(account.id, model);
          accountQuotaCharged = true;
          created = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            accountId: account.id,
            status: "accepted",
            message: settings.executorEnabled
              ? `已接收，已预扣 ${cost} 额度，已进入执行队列`
              : `已接收，已预扣 ${cost} 额度，自动执行已关闭`,
            prompt,
            referenceImagePath,
            referenceImagePaths,
            userId: apiUserId,
            creditCost: apiUserId ? USER_GENERATION_CREDIT_COST : 0,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
        } catch (error) {
          if (accountQuotaCharged) this.database.refundQuota(account.id, model);
          if (apiUserId && userCreditsCharged) {
            this.database.grantApiUserCredits(apiUserId, USER_GENERATION_CREDIT_COST, "接口任务记录失败，自动退回积分");
          }
          this.database.updateAccount({ id: account.id, currentStatus: "idle" });
          throw error;
        }
        if (settings.executorEnabled) {
          this.requestExecutor.enqueue(created.requestId);
        }
        this.database.appendOperationLog({
          requestId,
          accountId: account.id,
          action: "接收接口请求",
          status: "success",
          message: created.message
        });
        notifyDataChanged();
        void postCallback(created);
        sendJson(response, 202, toPublicApiRequest(created));
        return;
      }

      const recoveryMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/retry-result$/);
      if (request.method === "POST" && recoveryMatch) {
        const requestId = decodeURIComponent(recoveryMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (principal.kind === "user" && principal.user.role !== "admin" && apiRequest.userId !== principal.user.id) {
          sendJson(response, 403, { error: "无权操作此任务" });
          return;
        }
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account" });
          return;
        }
        this.requestExecutor.enqueueRecovery(requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: apiRequest.accountId,
          action: "恢复视频结果",
          status: "info",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        sendJson(response, 202, {
          requestId,
          status: "accepted",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        return;
      }

      const videoMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/video\.mp4$/);
      if (request.method === "GET" && videoMatch) {
        const requestId = decodeURIComponent(videoMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (principal.kind === "user" && principal.user.role !== "admin" && apiRequest.userId !== principal.user.id) {
          sendJson(response, 403, { error: "无权下载此视频" });
          return;
        }
        if (!apiRequest.cleanVideoUrl) {
          sendJson(response, 409, { error: "任务尚未生成可下载视频" });
          return;
        }
        await proxyMp4Video(request, response, apiRequest.requestId, apiRequest.cleanVideoUrl);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (principal.kind === "user" && principal.user.role !== "admin" && apiRequest.userId !== principal.user.id) {
          sendJson(response, 403, { error: "无权查看此任务" });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(apiRequest));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/watermark/parse") {
        if (!isAdminPrincipal(principal)) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        const body = await readJsonBody<{ url?: string }>(request);
        const sourceUrl = body.url?.trim();
        if (!sourceUrl) {
          sendJson(response, 400, { error: "url is required" });
          return;
        }
        try {
          const cleanVideoUrl = await resolveCleanVideoUrl(settings, sourceUrl);
          recordOperation(null, null, "独立去水印解析", "success", "已验证真实 MP4 地址", sourceUrl);
          sendJson(response, 200, {
            status: "success",
            message: "去水印 MP4 地址已验证",
            cleanVideoUrl,
            outputVideoPath: null
          });
        } catch (error) {
          recordOperation(
            null,
            null,
            "独立去水印解析",
            "failed",
            error instanceof Error ? error.message : "去水印解析失败",
            sourceUrl
          );
          sendJson(response, 422, {
            status: "failed",
            message: error instanceof Error ? error.message : "去水印解析失败",
            cleanVideoUrl: null,
            outputVideoPath: null
          });
        }
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const clientError = [
        "参考图最多只能选择 10 张",
        "用户名需为",
        "密码长度需为",
        "请求体不能超过",
        "Unexpected token"
      ].some((fragment) => message.includes(fragment));
      sendJson(response, clientError ? 400 : 500, { error: message });
    }
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "Dola账号池接口服务",
    webPreferences: {
      preload: path.join(__dirname, "preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

async function createDolaWindow(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  await ensureDolaExtension(accountSession, account.partition);
  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: `Dola - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void win.loadURL("https://www.dola.com/chat");
}

async function detectLoginStatus(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  const cookies = await accountSession.cookies.get({ url: "https://www.dola.com" });
  const activeRequest = db.listApiRequests(1000).some((request) =>
    request.accountId === accountId && (request.status === "accepted" || request.status === "running")
  );
  return db.updateAccount({
    id: accountId,
    loginStatus: cookies.length > 0 ? "logged_in" : "logged_out",
    currentStatus: cookies.length > 0
      ? activeRequest
        ? "busy"
        : "idle"
      : "login_required"
  });
}

async function detectAllLoginStatuses() {
  const accounts = db.listAccounts();
  for (const account of accounts) {
    await detectLoginStatus(account.id);
  }
  return db.listAccounts();
}

async function clearAccountSession(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  return db.updateAccount({
    id: accountId,
    loginStatus: "logged_out",
    currentStatus: "login_required"
  });
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => db.listAccounts());
  ipcMain.handle("accounts:create", (_event, remark?: string) => {
    const account = db.createAccount({ remark });
    recordOperation(null, account.id, "创建账号", "success", `已创建 ${account.partition}`);
    return account;
  });
  ipcMain.handle("accounts:update", (_event, input: AccountUpdateInput) => {
    const account = db.updateAccount(input);
    recordOperation(null, account.id, "修改账号设置", "success", "已保存账号备注和额度设置");
    return account;
  });
  ipcMain.handle("accounts:delete", async (_event, id: number) => {
    const account = db.getAccount(id);
    await clearAccountSession(id);
    recordOperation(null, id, "删除账号", "success", `已删除 ${account?.partition || id}`);
    db.deleteAccount(id);
    return true;
  });
  ipcMain.handle("accounts:open", async (_event, id: number) => {
    await createDolaWindow(id);
    recordOperation(null, id, "打开Dola窗口", "success", "已打开独立账号窗口");
    return true;
  });
  ipcMain.handle("accounts:relogin", async (_event, id: number) => {
    await clearAccountSession(id);
    await createDolaWindow(id);
    recordOperation(null, id, "重新登录账号", "success", "已清空登录状态并打开登录窗口");
    return true;
  });
  ipcMain.handle("accounts:detect-login", async (_event, id: number) => {
    const account = await detectLoginStatus(id);
    recordOperation(null, id, "检测登录状态", "success", `当前状态：${account.loginStatus}`);
    return account;
  });
  ipcMain.handle("accounts:detect-all", async () => {
    const accounts = await detectAllLoginStatuses();
    recordOperation(null, null, "检测全部账号", "success", `已检测 ${accounts.length} 个账号`);
    return accounts;
  });
  ipcMain.handle("accounts:reset-quota", (_event, id: number) => {
    const accounts = db.resetAccountQuota(id);
    recordOperation(null, id, "重置账号额度", "success", "已重置今日额度");
    return accounts;
  });
  ipcMain.handle("accounts:reset-all-quotas", () => {
    const accounts = db.resetAllQuotas();
    recordOperation(null, null, "重置全部额度", "success", `已重置 ${accounts.length} 个账号`);
    return accounts;
  });

  ipcMain.handle("settings:get", () => db.getSettings());
  ipcMain.handle("settings:update", async (_event, input: AppSettingsUpdateInput) => {
    const settings = db.updateSettings(input);
    await apiServer.applySettings(settings);
    await tcpApiServer.applySettings(settings);
    recordOperation(null, null, "保存配置", "success", "配置已保存并应用");
    return settings;
  });

  ipcMain.handle("api-server:status", () => apiServer.getStatus());
  ipcMain.handle("api-server:restart", async () => {
    const settings = db.getSettings();
    await apiServer.applySettings(settings);
    await tcpApiServer.applySettings(settings);
    return apiServer.getStatus();
  });
  ipcMain.handle("tcp-server:status", () => tcpApiServer.getStatus());
  ipcMain.handle("tcp-server:restart", async () => tcpApiServer.applySettings(db.getSettings()));

  ipcMain.handle("api-requests:list", (_event, limit?: number) => db.listApiRequests(limit || 100));
  ipcMain.handle("api-requests:clear", () => {
    db.clearApiRequests();
    return true;
  });
  ipcMain.handle("api-users:list", () => db.listApiUsers());
  ipcMain.handle("api-users:create", (_event, input: ApiUserCreateInput) => {
    const credentials = validateCredentials(input.username, input.password);
    if (db.getApiUserAuthByUsername(credentials.username)) throw new Error("用户名已存在");
    const password = hashPassword(credentials.password);
    const user = db.createApiUser(
      {
        username: credentials.username,
        password: "",
        role: input.role === "admin" ? "admin" : "user",
        initialCredits: Math.max(0, Math.trunc(Number(input.initialCredits) || 0))
      },
      password.hash,
      password.salt
    );
    recordOperation(null, null, "创建接口用户", "success", `已创建用户 ${user.username}`);
    return user;
  });
  ipcMain.handle("api-users:grant", (_event, input: { userId: number; amount: number; note?: string }) => {
    const amount = Math.trunc(Number(input.amount));
    if (!amount) throw new Error("积分变动不能为 0");
    const user = db.grantApiUserCredits(input.userId, amount, String(input.note || "管理端调整积分"));
    recordOperation(null, null, "调整用户积分", "success", `${user.username} ${amount > 0 ? "+" : ""}${amount}，余额 ${user.credits}`);
    return user;
  });
  ipcMain.handle("api-users:set-disabled", (_event, input: { userId: number; disabled: boolean }) => {
    const user = db.setApiUserDisabled(input.userId, input.disabled);
    recordOperation(null, null, input.disabled ? "停用接口用户" : "启用接口用户", "success", user.username);
    return user;
  });
  ipcMain.handle("credit-ledger:list", (_event, userId?: number, limit?: number) =>
    db.listCreditLedger(userId, limit || 500)
  );
  ipcMain.handle("operation-logs:list", (_event, limit?: number) => db.listOperationLogs(limit || 500));
  ipcMain.handle("operation-logs:clear", () => {
    db.clearOperationLogs();
    return true;
  });
}

function recordOperation(
  requestId: string | null,
  accountId: number | null,
  action: string,
  status: "info" | "success" | "failed",
  message: string,
  targetUrl?: string | null
) {
  db.appendOperationLog({ requestId, accountId, action, status, message, targetUrl });
  notifyDataChanged();
}

function notifyDataChanged() {
  mainWindow?.webContents.send("data:changed");
}

function normalizeModel(model: string): DolaModel | null {
  if (model === "seedance_2_5") return model;
  return null;
}

function authenticateRequest(
  request: IncomingMessage,
  apiKey: string,
  database: AppDatabase
): ApiPrincipal | null {
  const token = bearerToken(request);
  if (!token) return null;
  if (apiKey.trim() && token === apiKey.trim()) return { kind: "service" };
  const user = database.getApiUserBySessionHash(hashToken(token));
  if (!user || user.disabled) return null;
  return { kind: "user", user };
}

function bearerToken(request: IncomingMessage) {
  const authorization = String(request.headers.authorization || "");
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

function isAdminPrincipal(principal: ApiPrincipal) {
  return principal.kind === "service" || principal.user.role === "admin";
}

function validateCredentials(rawUsername?: string, rawPassword?: string) {
  const username = String(rawUsername || "").trim();
  const password = String(rawPassword || "");
  if (!/^[A-Za-z0-9_\-]{3,32}$/.test(username)) {
    throw new Error("用户名需为 3-32 位字母、数字、下划线或连字符");
  }
  if (password.length < 8 || password.length > 128) {
    throw new Error("密码长度需为 8-128 位");
  }
  return { username, password };
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: scryptSync(password, salt, 64).toString("hex")
  };
}

function verifyPassword(password: string, salt: string, expectedHash: string) {
  try {
    const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function issueUserSession(database: AppDatabase, userId: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + USER_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  database.createApiSession(userId, hashToken(token), expiresAt);
  return token;
}

function toPublicUser(user: ApiUser) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    credits: user.credits,
    disabled: user.disabled,
    createdAt: user.createdAt
  };
}

async function readGenerateRequest(request: IncomingMessage, requestId: string): Promise<GenerateRequestBody> {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartGenerateRequest(await readBufferBody(request), contentType, requestId);
  }
  return readJsonBody<GenerateRequestBody>(request);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const raw = (await readBufferBody(request)).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function readBufferBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 120 * 1024 * 1024) throw new Error("请求体不能超过 120MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function parseMultipartGenerateRequest(buffer: Buffer, contentType: string, requestId: string): Promise<GenerateRequestBody> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("multipart boundary is required");

  const fields: Record<string, string> = {};
  const uploadedReferenceImagePaths: string[] = [];
  const delimiter = Buffer.from(`--${boundary}`);

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    let part = rawPart;
    if (part.length === 0 || part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    if (disposition.filename) {
      if (body.length > 0) {
        if (uploadedReferenceImagePaths.length >= 10) throw new Error("参考图最多只能选择 10 张");
        uploadedReferenceImagePaths.push(await saveUploadedFile({
          requestId,
          fieldName: disposition.name,
          filename: disposition.filename,
          contentType: headers["content-type"],
          bytes: body,
          sequence: uploadedReferenceImagePaths.length + 1
        }));
      }
      continue;
    }

    fields[disposition.name] = body.toString("utf8");
  }

  return {
    model: fields.model as DolaModel | undefined,
    prompt: fields.prompt || "",
    referenceImagePath: uploadedReferenceImagePaths[0] || fields.referenceImagePath || null,
    referenceImagePaths: uploadedReferenceImagePaths,
    referenceImageUrl: fields.referenceImageUrl || null,
    removeWatermark: parseOptionalBoolean(fields.removeWatermark),
    callbackUrl: fields.callbackUrl || null,
    source: fields.source || "multipart-api"
  };
}

async function prepareReferenceImages(body: GenerateRequestBody, requestId: string) {
  const normalizeStrings = (items: unknown[]) => items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  const localPaths = normalizeStrings([
    ...(Array.isArray(body.referenceImagePaths) ? body.referenceImagePaths : []),
    body.referenceImagePath || ""
  ]);
  const imageUrls = normalizeStrings([
    ...(Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : []),
    body.referenceImageUrl || ""
  ]);
  const uniquePaths = [...new Set(localPaths)];
  const uniqueUrls = [...new Set(imageUrls)];
  if (uniquePaths.length + uniqueUrls.length > 10) {
    throw new Error("参考图最多只能选择 10 张");
  }

  const result = [...uniquePaths];
  for (const [index, imageUrl] of uniqueUrls.entries()) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`第 ${index + 1} 张参考图下载失败：HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const urlExt = path.extname(new URL(imageUrl).pathname);
    const ext = urlExt || extensionFromContentType(contentType) || ".png";
    const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
    await fs.mkdir(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, `${requestId}-reference-${result.length + 1}${ext}`);
    await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
    result.push(imagePath);
  }
  return result;
}

async function saveUploadedFile(input: {
  requestId: string;
  fieldName: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
  sequence?: number;
}) {
  const safeName = sanitizeFilename(input.filename || `${input.fieldName}${extensionFromContentType(input.contentType) || ".png"}`);
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${input.requestId}-${input.fieldName}-${input.sequence || 1}-${safeName}`);
  await fs.writeFile(filePath, input.bytes);
  return filePath;
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) {
      parts.push(buffer.subarray(start, index));
    }
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parsePartHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string) {
  const result: { name?: string; filename?: string } = {};
  for (const item of value.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    const unquoted = rawValue.join("=").trim().replace(/^"|"$/g, "");
    if (key === "name") result.name = unquoted;
    if (key === "filename") result.filename = unquoted;
  }
  return result;
}

function parseOptionalBoolean(value: string | undefined) {
  if (value == null || value === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function extensionFromContentType(contentType?: string) {
  if (!contentType) return null;
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return null;
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return cleaned.slice(0, 120) || "reference-image";
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function proxyMp4Video(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  sourceUrl: string
) {
  const headers: Record<string, string> = {};
  if (request.headers.range) headers.Range = String(request.headers.range);
  const upstream = await fetch(sourceUrl, { headers, redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    sendJson(response, upstream.status || 502, { error: `视频源访问失败：HTTP ${upstream.status || 502}` });
    return;
  }

  const responseHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
    "Content-Type": "video/mp4",
    "Content-Disposition": `inline; filename="${sanitizeFilename(requestId)}.mp4"`,
    "Cache-Control": "private, max-age=300"
  };
  for (const name of ["content-length", "content-range", "accept-ranges"] as const) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  response.writeHead(upstream.status, responseHeaders);
  const stream = Readable.fromWeb(upstream.body as never);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

async function postCallback(payload: ApiRequest) {
  if (!payload.callbackUrl) return;
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toPublicApiRequest(payload))
  }).catch(() => undefined);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    log.initialize();
    db = new AppDatabase();
    executor = new DolaExecutor(db, notifyDataChanged);
    apiServer = new LocalApiServer(db, executor);
    tcpApiServer = new TcpApiServer(() => apiServer.getStatus());
    registerIpc();
    await apiServer.applySettings(db.getSettings());
    await tcpApiServer.applySettings(db.getSettings());
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  }).catch((error) => {
    log.error(error);
  });
}

app.on("before-quit", async () => {
  await tcpApiServer?.stop();
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
