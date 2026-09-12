export type LoginStatus = "unknown" | "logged_in" | "logged_out";
export type AccountRuntimeStatus = "idle" | "busy" | "error" | "login_required";
export type DolaModel = "seedance_2_0" | "seedance_2_5";
export type ApiRequestStatus = "accepted" | "running" | "success" | "failed" | "stopped";
export type OperationLogStatus = "info" | "success" | "failed";

export interface Account {
  id: number;
  name: string;
  partition: string;
  remark: string;
  loginStatus: LoginStatus;
  currentStatus: AccountRuntimeStatus;
  dailyQuotaLimit: number;
  quotaRemaining: number;
  quotaUsedToday: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCreateInput {
  remark?: string;
}

export interface AccountUpdateInput {
  id: number;
  remark?: string;
  loginStatus?: LoginStatus;
  currentStatus?: AccountRuntimeStatus;
  dailyQuotaLimit?: number;
  quotaRemaining?: number;
  quotaUsedToday?: number;
}

export interface AppSettings {
  apiServiceEnabled: boolean;
  apiPort: number;
  apiKey: string;
  executorEnabled: boolean;
  showExecutorWindow: boolean;
  autoCloseExecutorWindow: boolean;
  dolaChatUrl: string;
  defaultModel: DolaModel;
  dailyQuotaLimit: number;
  seedance20Cost: number;
  seedance25Cost: number;
  dailyResetTime: string;
  generationTimeoutSeconds: number;
  maxConcurrentAccounts: number;
  retryCount: number;
  autoRemoveWatermark: boolean;
  watermarkApiUrl: string;
  watermarkApiToken: string;
  outputDir: string;
}

export type AppSettingsUpdateInput = Partial<AppSettings>;

export interface ApiRequest {
  id: number;
  requestId: string;
  source: string;
  model: DolaModel;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  status: ApiRequestStatus;
  message: string;
  prompt: string;
  referenceImagePath: string | null;
  removeWatermark: boolean;
  callbackUrl: string | null;
  dolaThreadUrl: string | null;
  rawVideoUrl: string | null;
  cleanVideoUrl: string | null;
  outputVideoPath: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ApiRequestCreateInput {
  requestId: string;
  source?: string;
  model: DolaModel;
  accountId?: number | null;
  status: ApiRequestStatus;
  message?: string;
  prompt: string;
  referenceImagePath?: string | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
}

export interface ApiRequestUpdateInput {
  requestId: string;
  status?: ApiRequestStatus;
  message?: string;
  dolaThreadUrl?: string | null;
  rawVideoUrl?: string | null;
  cleanVideoUrl?: string | null;
  outputVideoPath?: string | null;
}

export interface OperationLog {
  id: number;
  requestId: string | null;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  action: string;
  status: OperationLogStatus;
  message: string;
  targetUrl: string | null;
  createdAt: string;
}

export interface OperationLogCreateInput {
  requestId?: string | null;
  accountId?: number | null;
  action: string;
  status?: OperationLogStatus;
  message: string;
  targetUrl?: string | null;
}

export interface ApiServerStatus {
  version: string;
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  message: string;
}

export interface GenerateRequestBody {
  model?: DolaModel;
  prompt: string;
  referenceImagePath?: string | null;
  referenceImageUrl?: string | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
  source?: string;
}
