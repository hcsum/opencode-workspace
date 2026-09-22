import path from "node:path";

import dotenv from "dotenv";

import type {
  AppConfig,
  ClaudePermissionMode,
  ImapSmtpChannelConfig,
  OpenCodeModelRef,
  ProviderName,
} from "./types.js";

dotenv.config();

function parseModel(
  raw?: string | undefined,
): OpenCodeModelRef | undefined {
  if (!raw?.trim()) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0)
    throw new Error(`OPENCODE_MODEL must be "provider/modelid", got: ${raw}`);
  return {
    providerID: raw.slice(0, slash).trim(),
    modelID: raw.slice(slash + 1).trim(),
  };
}

function parseProvider(raw?: string): ProviderName {
  const value = raw?.trim().toLowerCase() || "opencode";
  if (value === "opencode" || value === "claude") {
    return value;
  }
  throw new Error(`PROVIDER must be "opencode" or "claude", got: ${raw}`);
}

function parseClaudePermissionMode(raw?: string): ClaudePermissionMode | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const allowed: ClaudePermissionMode[] = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
  ];
  if (allowed.includes(value as ClaudePermissionMode)) {
    return value as ClaudePermissionMode;
  }
  throw new Error(
    `CLAUDE_PERMISSION_MODE must be one of ${allowed.join(", ")}, got: ${raw}`,
  );
}

function parseImapConfig(
  inboxEmail: string | undefined,
): ImapSmtpChannelConfig {
  const user = process.env.EMAIL_USER?.trim() || inboxEmail;
  const password = process.env.EMAIL_PASSWORD?.trim();
  const imapHost = process.env.IMAP_HOST?.trim();
  const smtpHost = process.env.SMTP_HOST?.trim();

  if (!user) {
    throw new Error("Email bridge requires EMAIL_USER (or AGENT_INBOX_EMAIL)");
  }
  if (!password) {
    throw new Error("Email bridge requires EMAIL_PASSWORD");
  }
  if (!imapHost) {
    throw new Error("Email bridge requires IMAP_HOST");
  }
  if (!smtpHost) {
    throw new Error("Email bridge requires SMTP_HOST");
  }

  const imapPort = Number(process.env.IMAP_PORT) || 993;
  const smtpPort = Number(process.env.SMTP_PORT) || 465;

  return {
    user,
    password,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    imapSecure: parseBool(process.env.IMAP_SECURE, imapPort === 993),
    smtpSecure: parseBool(process.env.SMTP_SECURE, smtpPort === 465),
  };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1" || value === "yes";
}

export function loadConfig(): AppConfig {
  const provider = parseProvider(
    process.env.PROVIDER || process.env.AGENT_PROVIDER,
  );
  const opencodeBaseUrl = process.env.OPENCODE_BASE_URL?.trim();
  const gmailInboxEmail =
    process.env.AGENT_INBOX_EMAIL?.trim() ||
    process.env.GMAIL_TO?.trim() ||
    undefined;
  const gmailUserEmail =
    process.env.USER_EMAIL?.trim() ||
    process.env.SCHEDULED_RESULTS_TO?.trim() ||
    undefined;
  const imap = gmailInboxEmail ? parseImapConfig(gmailInboxEmail) : undefined;

  if (provider === "opencode" && !opencodeBaseUrl) {
    throw new Error("Missing required environment variable: OPENCODE_BASE_URL");
  }

  return {
    provider,
    providers: {
      ...(opencodeBaseUrl
        ? {
            opencode: {
              baseUrl: opencodeBaseUrl,
              serverUsername:
                process.env.OPENCODE_SERVER_USERNAME?.trim() || undefined,
              serverPassword:
                process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
              model: parseModel(process.env.OPENCODE_MODEL),
              fallbackModel: parseModel(process.env.OPENCODE_MODEL_FALLBACK),
            },
          }
        : {}),
      claude: {
        model: process.env.CLAUDE_MODEL?.trim() || undefined,
        fallbackModel: process.env.CLAUDE_MODEL_FALLBACK?.trim() || undefined,
        workingDirectory:
          process.env.CLAUDE_WORKING_DIRECTORY?.trim() || process.cwd(),
        permissionMode: parseClaudePermissionMode(
          process.env.CLAUDE_PERMISSION_MODE,
        ),
      },
    },
    channels: {
      gmail: {
        inboxEmail: gmailInboxEmail,
        userEmail: gmailUserEmail,
        scheduledResultsTo:
          process.env.SCHEDULED_RESULTS_TO?.trim() || undefined,
        pollIntervalMs: Number(process.env.GMAIL_POLL_INTERVAL_MS) || 10000,
        newerThan: process.env.GMAIL_NEWER_THAN?.trim() || "3d",
        imap,
      },
    },
    stateFile:
      process.env.STATE_FILE?.trim() || path.join(".data", "state.json"),
    publicActivityDir:
      process.env.PUBLIC_ACTIVITY_DIR?.trim() ||
      path.join(".data", "public-activity"),
    userTimezone: process.env.USER_TIMEZONE?.trim() || "UTC",
    schedulerApiPort: Number(process.env.SCHEDULER_API_PORT) || 4097,
    deliveryApiPort: Number(process.env.GMAIL_DELIVERY_PORT) || 4098,
    schedulerMaxTasks: Number(process.env.SCHEDULER_MAX_TASKS) || 20,
    schedulerMinIntervalMinutes:
      Number(process.env.SCHEDULER_MIN_INTERVAL_MINUTES) || 5,
    publicActivityMaxEvents:
      Number(process.env.PUBLIC_ACTIVITY_MAX_EVENTS) || 100,
    deployCommitSha: process.env.DEPLOY_COMMIT_SHA?.trim() || undefined,
    deployCommitMessage: process.env.DEPLOY_COMMIT_MESSAGE?.trim() || undefined,
    deployRunId: process.env.DEPLOY_RUN_ID?.trim() || undefined,
    deployActor: process.env.DEPLOY_ACTOR?.trim() || undefined,
    deployedAt: process.env.DEPLOYED_AT?.trim() || undefined,
  };
}
