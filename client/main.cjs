const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("node:fs/promises");
const tls = require("node:tls");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_FRAME_BYTES = 256 * 1024 * 1024;

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 820,
    minHeight: 640,
    title: "Dola API 客户端",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("tcp:request", async (_event, connection, command) => {
  return tcpRequest(connection, command);
});

ipcMain.handle("tcp:video", async (_event, connection, command) => {
  const response = await tcpRequest(connection, { ...command, action: "video.get" });
  const video = response.data;
  if (!video?.data) throw new Error("TCP 服务没有返回视频内容");
  const cacheDir = path.join(app.getPath("userData"), "video-cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const rawName = path.basename(String(video.filename || `${command.requestId}.mp4`));
  const cleanName = rawName.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 160) || "dola-video.mp4";
  const filePath = path.join(cacheDir, cleanName.toLowerCase().endsWith(".mp4") ? cleanName : `${cleanName}.mp4`);
  await fs.writeFile(filePath, Buffer.from(video.data, "base64"));
  return { fingerprint: response.fingerprint, filePath, fileUrl: pathToFileURL(filePath).href };
});

ipcMain.handle("tcp:save-video", async (_event, filePath, suggestedName) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName || path.basename(filePath),
    filters: [{ name: "MP4 视频", extensions: ["mp4"] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.copyFile(filePath, result.filePath);
  return { saved: true, filePath: result.filePath };
});

function tcpRequest(connection, command) {
  return new Promise((resolve, reject) => {
    const host = String(connection?.host || "").trim();
    const port = Number(connection?.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      reject(new Error("请填写正确的服务器地址和 TCP 端口"));
      return;
    }
    const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    let pending = Buffer.alloc(0);
    let expectedLength = null;
    let settled = false;
    const timeoutMs = command?.action === "video.get" ? 10 * 60 * 1000 : 120000;
    const timer = setTimeout(() => socket.destroy(new Error("TCP 请求超时")), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const fingerprint = String(certificate.fingerprint256 || "");
      if (!fingerprint) return finish(new Error("无法读取服务器 TLS 证书指纹"));
      if (connection.fingerprint && connection.fingerprint !== fingerprint) {
        return finish(new Error("服务器 TLS 证书指纹已变化，已拒绝连接。请向服务提供方核对后清除旧连接记录。"));
      }
      const body = Buffer.from(JSON.stringify(command));
      if (body.length > MAX_FRAME_BYTES) return finish(new Error("TCP 请求超过 256MB"));
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (expectedLength === null && pending.length >= 4) {
        expectedLength = pending.readUInt32BE(0);
        pending = pending.subarray(4);
        if (expectedLength < 1 || expectedLength > MAX_FRAME_BYTES) return finish(new Error("TCP 响应长度无效"));
      }
      if (expectedLength !== null && pending.length >= expectedLength) {
        try {
          const payload = JSON.parse(pending.subarray(0, expectedLength).toString("utf8"));
          const fingerprint = String(socket.getPeerCertificate().fingerprint256 || "");
          if (!payload.ok) return finish(new Error(payload.error || "TCP 请求失败"));
          finish(null, { data: payload.data, fingerprint });
        } catch (error) {
          finish(error instanceof Error ? error : new Error("TCP 响应解析失败"));
        }
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("TCP 连接已关闭，未收到完整响应"));
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
