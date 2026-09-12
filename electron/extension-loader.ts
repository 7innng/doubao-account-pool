import path from "node:path";
import { app, type Session } from "electron";
import log from "electron-log/main.js";

const EXTENSION_DIRECTORY = "dola-media-helper";
const loadPromises = new Map<string, Promise<void>>();

function extensionPath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "extensions",
      EXTENSION_DIRECTORY
    );
  }
  return path.join(app.getAppPath(), "extensions", EXTENSION_DIRECTORY);
}

export function ensureDolaExtension(accountSession: Session, partition: string) {
  const existing = loadPromises.get(partition);
  if (existing) return existing;

  const loading = accountSession.extensions
    .loadExtension(extensionPath())
    .then((extension) => {
      log.info(`[Dola extension] loaded ${extension.name} ${extension.version} for ${partition}`);
    })
    .catch((error) => {
      loadPromises.delete(partition);
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[Dola extension] failed for ${partition}: ${message}`);
      throw new Error(`Dola 媒体扩展加载失败：${message}`);
    });

  loadPromises.set(partition, loading);
  return loading;
}
