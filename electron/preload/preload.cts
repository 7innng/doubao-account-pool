import { contextBridge, ipcRenderer } from "electron";
import type { AccountUpdateInput, ApiUserCreateInput, AppSettingsUpdateInput } from "../types.js";

const api = {
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    create: (remark?: string) => ipcRenderer.invoke("accounts:create", remark),
    update: (input: AccountUpdateInput) => ipcRenderer.invoke("accounts:update", input),
    delete: (id: number) => ipcRenderer.invoke("accounts:delete", id),
    open: (id: number) => ipcRenderer.invoke("accounts:open", id),
    relogin: (id: number) => ipcRenderer.invoke("accounts:relogin", id),
    detectLogin: (id: number) => ipcRenderer.invoke("accounts:detect-login", id),
    detectAll: () => ipcRenderer.invoke("accounts:detect-all"),
    resetQuota: (id: number) => ipcRenderer.invoke("accounts:reset-quota", id),
    resetAllQuotas: () => ipcRenderer.invoke("accounts:reset-all-quotas")
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (input: AppSettingsUpdateInput) => ipcRenderer.invoke("settings:update", input)
  },
  apiServer: {
    status: () => ipcRenderer.invoke("api-server:status"),
    restart: () => ipcRenderer.invoke("api-server:restart")
  },
  apiRequests: {
    list: (limit?: number) => ipcRenderer.invoke("api-requests:list", limit),
    clear: () => ipcRenderer.invoke("api-requests:clear")
  },
  apiUsers: {
    list: () => ipcRenderer.invoke("api-users:list"),
    create: (input: ApiUserCreateInput) => ipcRenderer.invoke("api-users:create", input),
    grant: (input: { userId: number; amount: number; note?: string }) => ipcRenderer.invoke("api-users:grant", input),
    setDisabled: (input: { userId: number; disabled: boolean }) => ipcRenderer.invoke("api-users:set-disabled", input)
  },
  creditLedger: {
    list: (userId?: number, limit?: number) => ipcRenderer.invoke("credit-ledger:list", userId, limit)
  },
  operationLogs: {
    list: (limit?: number) => ipcRenderer.invoke("operation-logs:list", limit),
    clear: () => ipcRenderer.invoke("operation-logs:clear")
  },
  events: {
    onDataChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("data:changed", listener);
      return () => ipcRenderer.removeListener("data:changed", listener);
    }
  }
};

contextBridge.exposeInMainWorld("dolaManager", api);

export type DolaManagerApi = typeof api;
