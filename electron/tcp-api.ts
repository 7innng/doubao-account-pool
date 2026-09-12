import fs from "node:fs/promises";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
import { app } from "electron";
import selfsigned from "selfsigned";
import type { ApiServerStatus, AppSettings, TcpServerStatus } from "./types.js";

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 120 * 1024 * 1024;
const AUTH_WINDOW_MS = 60_000;
const AUTH_ATTEMPT_LIMIT = 20;

interface TcpCommand {
  id?: string;
  action?: string;
  token?: string;
  username?: string;
  password?: string;
  prompt?: string;
  requestId?: string;
  limit?: number;
  images?: Array<{ name?: string; type?: string; data?: string }>;
}

export class TcpApiServer {
  private server: tls.Server | null = null;
  private readonly authAttempts = new Map<string, { startedAt: number; count: number }>();
  private status: TcpServerStatus = {
    version: app.getVersion(),
    enabled: false,
    running: false,
    host: "0.0.0.0",
    port: 0,
    address: null,
    fingerprint: null,
    message: "未启动"
  };

  constructor(private readonly getHttpStatus: () => ApiServerStatus) {}

  async applySettings(settings: AppSettings) {
    await this.stop();
    this.status = {
      version: app.getVersion(),
      enabled: settings.tcpServiceEnabled,
      running: false,
      host: "0.0.0.0",
      port: settings.tcpPort,
      address: null,
      fingerprint: null,
      message: settings.tcpServiceEnabled ? "启动中" : "已关闭"
    };
    if (!settings.tcpServiceEnabled) return this.status;

    const httpStatus = this.getHttpStatus();
    if (!httpStatus.running || !httpStatus.url) {
      this.status.message = "内部 API 未运行，TCP 服务无法启动";
      return this.status;
    }

    const certificate = await ensureTcpCertificate();
    this.server = tls.createServer(
      { key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2" },
      (socket) => {
        this.handleSocket(socket, httpStatus.url!);
      }
    );
    this.server.maxConnections = 200;

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = { ...this.status, running: false, address: null, message: `启动失败：${error.message}` };
        resolve();
      });
      this.server!.listen(settings.tcpPort, "0.0.0.0", () => {
        this.status = {
          ...this.status,
          running: true,
          address: `0.0.0.0:${settings.tcpPort}`,
          fingerprint: certificate.fingerprint,
          message: "TLS/TCP 运行中"
        };
        resolve();
      });
    });
    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private handleSocket(socket: TLSSocket, httpBaseUrl: string) {
    let pending = Buffer.alloc(0);
    let queue = Promise.resolve();
    socket.setTimeout(10 * 60 * 1000, () => socket.destroy(new Error("TCP connection timeout")));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          socket.destroy(new Error("TCP frame is too large"));
          return;
        }
        if (pending.length < length + 4) return;
        const frame = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        queue = queue.then(() => this.handleFrame(socket, httpBaseUrl, frame));
      }
    });
    socket.on("error", () => undefined);
  }

  private async handleFrame(socket: TLSSocket, httpBaseUrl: string, frame: Buffer) {
    let command: TcpCommand = {};
    try {
      command = JSON.parse(frame.toString("utf8")) as TcpCommand;
      if (["login", "register"].includes(String(command.action || "")) && !this.consumeAuthAttempt(socket.remoteAddress)) {
        throw new Error("登录或注册操作过于频繁，请 1 分钟后再试");
      }
      const data = await dispatchCommand(httpBaseUrl, command);
      writeFrame(socket, { id: command.id || null, ok: true, data });
    } catch (error) {
      writeFrame(socket, {
        id: command?.id || null,
        ok: false,
        error: error instanceof Error ? error.message : "TCP 请求失败"
      });
    }
  }

  private consumeAuthAttempt(remoteAddress?: string) {
    const now = Date.now();
    const key = remoteAddress || "unknown";
    const current = this.authAttempts.get(key);
    if (!current || now - current.startedAt >= AUTH_WINDOW_MS) {
      this.authAttempts.set(key, { startedAt: now, count: 1 });
      if (this.authAttempts.size > 1_000) {
        for (const [address, attempt] of this.authAttempts) {
          if (now - attempt.startedAt >= AUTH_WINDOW_MS) this.authAttempts.delete(address);
        }
      }
      return true;
    }
    current.count += 1;
    return current.count <= AUTH_ATTEMPT_LIMIT;
  }
}

async function dispatchCommand(httpBaseUrl: string, command: TcpCommand) {
  const action = String(command.action || "");
  if (action === "health") return requestJson(httpBaseUrl, "/health");
  if (action === "register" || action === "login") {
    return requestJson(httpBaseUrl, `/api/auth/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: command.username, password: command.password })
    });
  }

  const token = String(command.token || "");
  if (!token) throw new Error("请先登录");
  const headers = { Authorization: `Bearer ${token}` };
  if (action === "logout") return requestJson(httpBaseUrl, "/api/auth/logout", { method: "POST", headers });
  if (action === "me") return requestJson(httpBaseUrl, "/api/me", { headers });
  if (action === "credits") return requestJson(httpBaseUrl, "/api/me/credits", { headers });
  if (action === "requests") {
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(command.limit) || 20)));
    return requestJson(httpBaseUrl, `/api/me/requests?limit=${limit}`, { headers });
  }
  if (action === "request.get") {
    return requestJson(httpBaseUrl, `/api/requests/${encodeURIComponent(String(command.requestId || ""))}`, { headers });
  }
  if (action === "generate") return submitGeneration(httpBaseUrl, command, token);
  if (action === "video.get") return getVideo(httpBaseUrl, command, token);
  throw new Error(`不支持的 TCP action：${action || "empty"}`);
}

async function submitGeneration(httpBaseUrl: string, command: TcpCommand, token: string) {
  const images = Array.isArray(command.images) ? command.images : [];
  if (images.length > 10) throw new Error("参考图最多只能选择 10 张");
  const form = new FormData();
  form.append("prompt", String(command.prompt || ""));
  form.append("model", "seedance_2_5");
  form.append("source", "tls-tcp-client");
  let totalBytes = 0;
  images.forEach((image, index) => {
    const bytes = Buffer.from(String(image.data || ""), "base64");
    totalBytes += bytes.length;
    if (totalBytes > MAX_IMAGE_BYTES) throw new Error("参考图总大小不能超过 120MB");
    const name = sanitizeFilename(image.name || `reference-${index + 1}.png`);
    form.append("referenceImage", new Blob([new Uint8Array(bytes)], { type: image.type || "image/png" }), name);
  });
  return requestJson(httpBaseUrl, "/api/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
}

async function getVideo(httpBaseUrl: string, command: TcpCommand, token: string) {
  const requestId = String(command.requestId || "");
  if (!requestId) throw new Error("requestId is required");
  const response = await fetch(`${httpBaseUrl}/api/requests/${encodeURIComponent(requestId)}/video.mp4`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(await responseError(response));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("视频文件为空");
  return { requestId, filename: `${sanitizeFilename(requestId)}.mp4`, data: bytes.toString("base64") };
}

async function requestJson(httpBaseUrl: string, pathname: string, init?: RequestInit) {
  const response = await fetch(`${httpBaseUrl}${pathname}`, init);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`内部 API 返回非 JSON：HTTP ${response.status}`);
  }
  if (!response.ok) {
    const record = payload as { error?: string; message?: string };
    throw new Error(record.error || record.message || `HTTP ${response.status}`);
  }
  return payload;
}

async function responseError(response: Response) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return payload.error || payload.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function writeFrame(socket: TLSSocket, payload: unknown) {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > MAX_FRAME_BYTES) {
    writeFrame(socket, { ok: false, error: "TCP 响应超过 256MB" });
    return;
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  socket.write(Buffer.concat([header, body]));
}

async function ensureTcpCertificate() {
  const directory = path.join(app.getPath("userData"), "tcp-tls");
  const keyPath = path.join(directory, "server-key.pem");
  const certPath = path.join(directory, "server-cert.pem");
  await fs.mkdir(directory, { recursive: true });
  let key: string;
  let cert: string;
  try {
    [key, cert] = await Promise.all([fs.readFile(keyPath, "utf8"), fs.readFile(certPath, "utf8")]);
  } catch {
    const generated = selfsigned.generate(
      [{ name: "commonName", value: "Dola TCP API" }],
      { days: 3650, keySize: 2048, algorithm: "sha256" }
    );
    key = generated.private;
    cert = generated.cert;
    await Promise.all([
      fs.writeFile(keyPath, key, { mode: 0o600 }),
      fs.writeFile(certPath, cert, { mode: 0o644 })
    ]);
  }
  return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}

function sanitizeFilename(value: string) {
  return value.replace(/[/\\?%*:|"<>]/g, "_").trim().slice(0, 120) || "dola-video";
}
