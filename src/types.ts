export type ProviderName = "opencode" | "claude";

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export interface OpencodeProviderConfig {
  baseUrl: string;
  serverUsername?: string;
  serverPassword?: string;
  model?: OpenCodeModelRef;
  fallbackModel?: OpenCodeModelRef;
}

export interface ClaudeProviderConfig {
  model?: string;
  fallbackModel?: string;
  workingDirectory?: string;
  permissionMode?: ClaudePermissionMode;
}

export interface ImapSmtpChannelConfig {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  imapSecure: boolean;
  smtpSecure: boolean;
}

export interface GmailChannelConfig {
  inboxEmail?: string;
  userEmail?: string;
  scheduledResultsTo?: string;
  pollIntervalMs: number;
  newerThan: string;
  imap?: ImapSmtpChannelConfig;
}

export interface AppConfig {
  provider: ProviderName;
  providers: {
    opencode?: OpencodeProviderConfig;
    claude?: ClaudeProviderConfig;
  };
  channels: {
    gmail?: GmailChannelConfig;
  };
  stateFile: string;
  publicActivityDir: string;
  userTimezone: string;
  schedulerApiPort: number;
  deliveryApiPort: number;
  schedulerMaxTasks: number;
  schedulerMinIntervalMinutes: number;
  publicActivityMaxEvents: number;
  deployCommitSha?: string;
  deployCommitMessage?: string;
  deployRunId?: string;
  deployActor?: string;
  deployedAt?: string;
}

export type WorkflowJobKind = "ingest" | "query" | "lint";

export type ThreadRunStatus =
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "completed"
  | "failed";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export type IngestLanguageMode = "source-original-wiki-zh" | "all-zh" | "preserve-language";

export type WorkflowJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface WorkflowCommand {
  kind: WorkflowJobKind;
  target: string;
  rawText: string;
  resolvedTarget?: string;
  ingestLanguageMode?: IngestLanguageMode;
}

export interface PersistedState {
  sessions?: Record<string, string>;
  updatedAt?: string;
}

export interface QueueJob<T> {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface TurnInput {
  text: string;
  senderName: string;
  chatTitle?: string;
  timestamp: Date;
  sessionKey?: string;
  sessionTitle?: string;
  sessionDirectory?: string;
}
