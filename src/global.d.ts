import type {
  Account,
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  ApiUser,
  ApiUserCreateInput,
  AppSettings,
  AppSettingsUpdateInput,
  CreditLedgerEntry,
  OperationLog,
  TcpServerStatus
} from "../electron/types";

declare global {
  interface Window {
    dolaManager: {
      accounts: {
        list: () => Promise<Account[]>;
        create: (remark?: string) => Promise<Account>;
        update: (input: AccountUpdateInput) => Promise<Account>;
        delete: (id: number) => Promise<boolean>;
        open: (id: number) => Promise<void>;
        relogin: (id: number) => Promise<boolean>;
        detectLogin: (id: number) => Promise<Account>;
        detectAll: () => Promise<Account[]>;
        resetQuota: (id: number) => Promise<Account>;
        resetAllQuotas: () => Promise<Account[]>;
      };
      settings: {
        get: () => Promise<AppSettings>;
        update: (input: AppSettingsUpdateInput) => Promise<AppSettings>;
      };
      apiServer: {
        status: () => Promise<ApiServerStatus>;
        restart: () => Promise<ApiServerStatus>;
      };
      tcpServer: {
        status: () => Promise<TcpServerStatus>;
        restart: () => Promise<TcpServerStatus>;
      };
      apiRequests: {
        list: (limit?: number) => Promise<ApiRequest[]>;
        clear: () => Promise<boolean>;
      };
      apiUsers: {
        list: () => Promise<ApiUser[]>;
        create: (input: ApiUserCreateInput) => Promise<ApiUser>;
        grant: (input: { userId: number; amount: number; note?: string }) => Promise<ApiUser>;
        setDisabled: (input: { userId: number; disabled: boolean }) => Promise<ApiUser>;
      };
      creditLedger: {
        list: (userId?: number, limit?: number) => Promise<CreditLedgerEntry[]>;
      };
      operationLogs: {
        list: (limit?: number) => Promise<OperationLog[]>;
        clear: () => Promise<boolean>;
      };
      events: {
        onDataChanged: (callback: () => void) => () => void;
      };
    };
  }
}

export {};
