import fs from "node:fs";
import path from "node:path";

import type { WorkflowJobKind } from "./types.js";

const DEFAULT_MAX_EVENTS = 100;
const SKILL_ALLOWLIST = new Set([
  "check-keyword",
  "explain-code",
  "llm-wiki",
  "morning-report",
  "serp-inspection",
  "skill-authoring",
  "summarization",
  "use-ahrefs",
  "use-google-trends",
  "use-semrush",
  "use-webcafe",
  "web-access",
  "x-home-feed",
  "x-search",
]);

export type PublicEventType =
  | "deployment"
  | "agent_idle"
  | "task_received"
  | "task_queued"
  | "task_started"
  | "task_waiting"
  | "skill_loaded"
  | "research_started"
  | "web_data_started"
  | "draft_started"
  | "knowledge_update_started"
  | "scheduled_report_started"
  | "task_completed"
  | "task_failed"
  | "report_delivered";

export type PublicSource = "gmail" | "telegram" | "scheduler" | "workflow" | "session";

export type PublicChannelStatus = "idle" | "active" | "waiting" | "error";

export interface PublicTaskContext {
  activityKey: string;
  source: PublicSource;
  taskType: string;
  publicTitle: string;
}

export type PublicDomainEvent =
  | {
      type: "deployment";
      commitSha?: string;
      commitMessage?: string;
      runId?: string;
      actor?: string;
      deployedAt?: string;
    }
  | { type: "agent_idle" }
  | { type: "task_received"; task: PublicTaskContext }
  | { type: "task_queued"; task: PublicTaskContext }
  | { type: "task_started"; task: PublicTaskContext }
  | { type: "task_waiting"; task: PublicTaskContext; reason: "permission" | "question" }
  | { type: "skill_loaded"; task: PublicTaskContext; skillName: string }
  | { type: "research_started"; task: PublicTaskContext }
  | { type: "web_data_started"; task: PublicTaskContext }
  | { type: "draft_started"; task: PublicTaskContext }
  | { type: "knowledge_update_started"; task: PublicTaskContext }
  | { type: "scheduled_report_started"; task: PublicTaskContext }
  | { type: "task_completed"; task: PublicTaskContext; durationMs?: number }
  | { type: "task_failed"; task: PublicTaskContext; error?: string }
  | { type: "report_delivered"; task: PublicTaskContext };

export interface PublicActivityEntry {
  id: string;
  ts: string;
  type: PublicEventType;
  status: string;
  title: string;
  summary?: string;
  source?: PublicSource;
  taskType?: string;
  skillName?: string;
  durationMs?: number;
  commitSha?: string;
  commitMessage?: string;
  runId?: string;
  actor?: string;
}

export interface PublicChannelState {
  source: PublicSource;
  status: PublicChannelStatus;
  title: string;
  summary?: string;
  updatedAt: string;
  activeCount: number;
  taskType?: string;
  activityKey?: string;
}

export interface PublicCurrentState {
  status: string;
  title: string;
  summary?: string;
  updatedAt: string;
  activeCount: number;
  stats: PublicActivityStats;
  source?: PublicSource;
  taskType?: string;
  channels?: PublicChannelState[];
}

export interface PublicActivityStats {
  tasksHandled: number;
  tasksCompleted: number;
  tasksFailed: number;
}

export interface PublicActivityFile {
  updatedAt: string;
  events: PublicActivityEntry[];
  meta?: {
    deploymentFingerprint?: string;
    channels?: PublicChannelState[];
  };
}

interface DeploymentInfo {
  commitSha?: string;
  commitMessage?: string;
  runId?: string;
  actor?: string;
  deployedAt?: string;
}

const DEFAULT_STATS: PublicActivityStats = {
  tasksHandled: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
};

export class PublicEventPublisher {
  private readonly currentPath: string;
  private readonly eventsPath: string;
  private readonly activeRuns = new Set<string>();
  private readonly activeRunSources = new Map<string, PublicSource>();
  private readonly maxEvents: number;
  private readonly deploymentInfo?: DeploymentInfo;
  private events: PublicActivityEntry[] = [];
  private current: PublicCurrentState;
  private channelStates = new Map<PublicSource, PublicChannelState>();
  private sequence = 0;
  private deploymentFingerprint?: string;

  constructor(
    dir: string,
    maxEvents = DEFAULT_MAX_EVENTS,
    deploymentInfo?: DeploymentInfo,
  ) {
    this.maxEvents = maxEvents > 0 ? maxEvents : DEFAULT_MAX_EVENTS;
    this.deploymentInfo = deploymentInfo;
    fs.mkdirSync(dir, { recursive: true });
    this.currentPath = path.join(dir, "current.json");
    this.eventsPath = path.join(dir, "events.json");
    this.current = this.buildIdleState(new Date().toISOString());
    this.loadSnapshot();
    this.recordDeploymentIfNeeded();
    this.writeSnapshot();
  }

  emit(event: PublicDomainEvent): void {
    this.applyChannelUpdate(event);
    if ("task" in event) {
      if (event.type === "task_started") {
        this.activeRuns.add(event.task.activityKey);
        this.activeRunSources.set(event.task.activityKey, event.task.source);
      }
      if (event.type === "task_completed" || event.type === "task_failed") {
        this.activeRuns.delete(event.task.activityKey);
        this.activeRunSources.delete(event.task.activityKey);
      }
    }

    const entry = this.renderEvent(event);
    if (!entry) return;
    this.appendEntry(entry);
  }

  setIdleIfNoActiveRuns(): void {
    if (this.activeRuns.size > 0) return;
    this.clearIdleEligibleChannels();
    const last = this.events.at(-1);
    if (last?.type === "agent_idle") {
      this.current = this.buildCurrentState(last.ts, this.current.stats);
      this.writeSnapshot();
      return;
    }
    this.emit({ type: "agent_idle" });
  }

  private appendEntry(entry: PublicActivityEntry): void {
    const stats = nextStats(this.current.stats, entry.type);
    this.events.push(entry);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    this.current = this.buildCurrentState(entry.ts, stats);
    this.writeSnapshot();
  }

  private renderEvent(event: PublicDomainEvent): PublicActivityEntry | undefined {
    const ts = new Date().toISOString();

    switch (event.type) {
      case "deployment":
        return {
          id: this.nextId("deployment"),
          ts: event.deployedAt || ts,
          type: event.type,
          status: "deployment",
          title: buildDeploymentTitle(event.commitSha),
          ...(buildDeploymentSummary(event) ? { summary: buildDeploymentSummary(event) } : {}),
          ...(event.commitSha ? { commitSha: event.commitSha } : {}),
          ...(event.commitMessage ? { commitMessage: event.commitMessage } : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          ...(event.actor ? { actor: event.actor } : {}),
        };
      case "agent_idle":
        return {
          id: this.nextId("idle"),
          ts,
          type: event.type,
          status: "idle",
          title: "Agent idle",
        };
      case "task_received":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: `New ${event.task.publicTitle.toLowerCase()} activity.`,
        });
      case "task_queued":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: `${event.task.publicTitle} is queued.`,
        });
      case "task_started":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: `${event.task.publicTitle} is active.`,
        });
      case "task_waiting":
        return this.buildTaskEntry(ts, event.type, "waiting", event.task, channelTitle(event.task.source), {
          summary:
            event.reason === "permission"
              ? "Waiting for permission approval."
              : "Waiting for follow-up answer.",
        });
      case "skill_loaded":
        if (!SKILL_ALLOWLIST.has(event.skillName)) return undefined;
        return {
          id: this.nextId("skill"),
          ts,
          type: event.type,
          status: "active",
          title: channelTitle(event.task.source),
          summary: `Loaded skill ${event.skillName}.`,
          source: event.task.source,
          taskType: event.task.taskType,
          skillName: event.skillName,
        };
      case "research_started":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: "Researching sources.",
        });
      case "web_data_started":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: "Gathering web data.",
        });
      case "draft_started":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: "Drafting response.",
        });
      case "knowledge_update_started":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: "Updating knowledge.",
        });
      case "scheduled_report_started":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: "Preparing scheduled report.",
        });
      case "task_completed":
        return this.buildTaskEntry(ts, event.type, "idle", event.task, channelTitle(event.task.source), {
          summary: event.durationMs
            ? `${event.task.publicTitle} completed in ${formatDuration(event.durationMs)}.`
            : `${event.task.publicTitle} completed.`,
          durationMs: event.durationMs,
        });
      case "task_failed":
        return this.buildTaskEntry(ts, event.type, "error", event.task, channelTitle(event.task.source), {
          summary: sanitizeFailure(event.error) || `${event.task.publicTitle} failed.`,
        });
      case "report_delivered":
        return this.buildTaskEntry(ts, event.type, "active", event.task, channelTitle(event.task.source), {
          summary: "Response delivered.",
        });
    }
  }

  private buildTaskEntry(
    ts: string,
    type: PublicEventType,
    status: string,
    task: PublicTaskContext,
    title: string,
    options?: { summary?: string; durationMs?: number },
  ): PublicActivityEntry {
    return {
      id: this.nextId(type),
      ts,
      type,
      status,
      title,
      ...(options?.summary ? { summary: options.summary } : {}),
      source: task.source,
      taskType: task.taskType,
      ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    };
  }

  private applyChannelUpdate(event: PublicDomainEvent): void {
    if (!("task" in event)) {
      if (event.type === "agent_idle") {
        this.clearIdleEligibleChannels();
      }
      return;
    }

    const ts = new Date().toISOString();
    const source = event.task.source;
    const activeCount = this.computeNextActiveCount(event);
    const next = this.nextChannelState(event, ts, activeCount);
    if (next) {
      this.channelStates.set(source, next);
    }
  }

  private computeNextActiveCount(event: Extract<PublicDomainEvent, { task: PublicTaskContext }>): number {
    const source = event.task.source;
    const currentCount = this.countActiveRunsForSource(source);
    if (event.type === "task_started") {
      return currentCount + (this.activeRunSources.has(event.task.activityKey) ? 0 : 1);
    }
    if (event.type === "task_completed" || event.type === "task_failed") {
      return Math.max(0, currentCount - (this.activeRunSources.has(event.task.activityKey) ? 1 : 0));
    }
    return currentCount;
  }

  private nextChannelState(
    event: Extract<PublicDomainEvent, { task: PublicTaskContext }>,
    ts: string,
    activeCount: number,
  ): PublicChannelState | undefined {
    const base: PublicChannelState = {
      source: event.task.source,
      status: "idle",
      title: channelTitle(event.task.source),
      updatedAt: ts,
      activeCount,
      taskType: event.task.taskType,
      activityKey: event.task.activityKey,
    };

    switch (event.type) {
      case "task_received":
      case "task_queued":
      case "task_started":
      case "research_started":
      case "web_data_started":
      case "draft_started":
      case "knowledge_update_started":
      case "scheduled_report_started":
      case "report_delivered":
        return {
          ...base,
          status: "active",
          summary: `${event.task.publicTitle} active.`,
        };
      case "task_waiting":
        return {
          ...base,
          status: "waiting",
          summary:
            event.reason === "permission"
              ? "Waiting for permission approval."
              : "Waiting for follow-up answer.",
        };
      case "skill_loaded":
        if (!SKILL_ALLOWLIST.has(event.skillName)) return undefined;
        return {
          ...base,
          status: activeCount > 0 ? "active" : "idle",
          summary: `Loaded skill ${event.skillName}.`,
        };
      case "task_completed":
        return {
          ...base,
          status: activeCount > 0 ? "active" : "idle",
          summary: event.durationMs
            ? `${event.task.publicTitle} completed in ${formatDuration(event.durationMs)}.`
            : `${event.task.publicTitle} completed.`,
        };
      case "task_failed":
        return {
          ...base,
          status: "error",
          summary: sanitizeFailure(event.error) || `${event.task.publicTitle} failed.`,
        };
    }
  }

  private countActiveRunsForSource(source: PublicSource): number {
    let count = 0;
    for (const runSource of this.activeRunSources.values()) {
      if (runSource === source) count += 1;
    }
    return count;
  }

  private clearIdleEligibleChannels(): void {
    for (const [source, state] of this.channelStates.entries()) {
      if (this.countActiveRunsForSource(source) > 0) continue;
      if (state.status === "waiting" || state.status === "error") continue;
      this.channelStates.set(source, {
        ...state,
        status: "idle",
        summary: state.summary,
        updatedAt: new Date().toISOString(),
        activeCount: 0,
      });
    }
  }

  private buildCurrentState(ts: string, stats: PublicActivityStats): PublicCurrentState {
    const channels = Array.from(this.channelStates.values()).sort(compareChannels);
    const activeCount = this.activeRuns.size;
    const focus = pickFocusChannel(channels);

    if (!focus) {
      return {
        ...this.buildIdleState(ts),
        stats,
      };
    }

    return {
      status: focus.status,
      title: focus.title,
      ...(focus.summary ? { summary: focus.summary } : {}),
      updatedAt: ts,
      activeCount,
      stats,
      source: focus.source,
      ...(focus.taskType ? { taskType: focus.taskType } : {}),
      channels,
    };
  }

  private buildIdleState(ts: string): PublicCurrentState {
    return {
      status: "idle",
      title: "Agent idle",
      summary: "No active channel activity.",
      updatedAt: ts,
      activeCount: 0,
      stats: { ...DEFAULT_STATS },
      channels: Array.from(this.channelStates.values()).sort(compareChannels),
    };
  }

  private writeSnapshot(): void {
    const eventsFile = this.buildEventsFile();
    writeJsonAtomic(this.currentPath, this.current);
    writeJsonAtomic(this.eventsPath, eventsFile);
  }

  private buildEventsFile(): PublicActivityFile {
    return {
      updatedAt: new Date().toISOString(),
      events: this.events,
      meta: {
        ...(this.deploymentFingerprint
          ? { deploymentFingerprint: this.deploymentFingerprint }
          : {}),
        channels: Array.from(this.channelStates.values()).sort(compareChannels),
      },
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${Date.now()}-${this.sequence}`;
  }

  private loadSnapshot(): void {
    const eventsFile = readJsonFile<PublicActivityFile>(this.eventsPath);
    const current = readJsonFile<PublicCurrentState>(this.currentPath);

    if (eventsFile?.events) {
      this.events = eventsFile.events.slice(-this.maxEvents);
      this.sequence = this.events.length;
      this.deploymentFingerprint = eventsFile.meta?.deploymentFingerprint;
      if (Array.isArray(eventsFile.meta?.channels)) {
        this.channelStates = new Map(
          eventsFile.meta.channels.map((channel) => [channel.source, channel]),
        );
      }
    }

    if (current) {
      this.current = normalizeCurrentState(current);
      if (Array.isArray(current.channels) && current.channels.length > 0) {
        this.channelStates = new Map(current.channels.map((channel) => [channel.source, channel]));
      }
      // Older snapshots predate the stats field. Recover the counters from the
      // retained event log instead of falling back to zeros.
      if (!current.stats && this.events.length > 0) {
        this.current.stats = deriveStatsFromEvents(this.events);
      }
    } else if (this.events.length > 0) {
      const last = this.events.at(-1);
      if (last) {
        this.current = {
          status: last.status,
          title: last.title,
          ...(last.summary ? { summary: last.summary } : {}),
          updatedAt: last.ts,
          activeCount: 0,
          stats: deriveStatsFromEvents(this.events),
          ...(last.source ? { source: last.source } : {}),
          ...(last.taskType ? { taskType: last.taskType } : {}),
          channels: Array.from(this.channelStates.values()).sort(compareChannels),
        };
      }
    }
  }

  private recordDeploymentIfNeeded(): void {
    if (!this.deploymentInfo) return;
    const fingerprint = buildDeploymentFingerprint(this.deploymentInfo);
    if (!fingerprint) return;
    if (this.deploymentFingerprint === fingerprint) return;

    this.deploymentFingerprint = fingerprint;
    this.appendEntry(
      this.renderEvent({
        type: "deployment",
        ...this.deploymentInfo,
      }) as PublicActivityEntry,
    );
  }
}

export function buildPublicTaskContext(input: {
  activityKey: string;
  source: PublicSource;
  subject?: string;
  textBody?: string;
  summary?: string;
  workflowKind?: WorkflowJobKind;
}): PublicTaskContext {
  const text = [input.subject, input.textBody, input.summary]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (input.workflowKind === "ingest") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-ingest",
      publicTitle: "Knowledge ingest",
    };
  }

  if (input.workflowKind === "query") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-query",
      publicTitle: "Knowledge query",
    };
  }

  if (input.workflowKind === "lint") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-lint",
      publicTitle: "Knowledge lint",
    };
  }

  if (/morning report/.test(text)) {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: input.source === "scheduler" ? "scheduled-report" : "morning-report",
      publicTitle: "Morning report",
    };
  }

  if (/keyword|seo|serp|search the web|search web|research/.test(text)) {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "research",
      publicTitle: "Research task",
    };
  }

  if (input.source === "scheduler") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "scheduled-task",
      publicTitle: "Scheduled task",
    };
  }

  if (input.source === "workflow") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-task",
      publicTitle: "Knowledge task",
    };
  }

  if (input.source === "session") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "agent-session",
      publicTitle: "Agent session",
    };
  }

  if (input.source === "telegram") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "chat-task",
      publicTitle: "Chat task",
    };
  }

  return {
    activityKey: input.activityKey,
    source: input.source,
    taskType: "email-task",
    publicTitle: "Email task",
  };
}

export function extractLoadedSkillName(label: string): string | undefined {
  const match = label.match(/^Loaded skill:\s+([a-z0-9-]+)$/i);
  if (!match) return undefined;
  const skillName = match[1].trim();
  return SKILL_ALLOWLIST.has(skillName) ? skillName : undefined;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function sanitizeFailure(input?: string): string | undefined {
  if (!input?.trim()) return undefined;
  if (/permission/i.test(input)) {
    return "Waiting for permission was not possible for this task.";
  }
  if (/question/i.test(input)) {
    return "This task required an unavailable follow-up question.";
  }
  if (/idle/i.test(input)) {
    return "The task timed out after going idle.";
  }
  return "The task ended with an internal error.";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function normalizeCurrentState(current: PublicCurrentState): PublicCurrentState {
  return {
    ...current,
    stats: current.stats
      ? {
          tasksHandled: current.stats.tasksHandled || 0,
          tasksCompleted: current.stats.tasksCompleted || 0,
          tasksFailed: current.stats.tasksFailed || 0,
        }
      : { ...DEFAULT_STATS },
    ...(Array.isArray(current.channels)
      ? { channels: current.channels.map((channel) => ({ ...channel })) }
      : {}),
  };
}

function deriveStatsFromEvents(events: PublicActivityEntry[]): PublicActivityStats {
  return events.reduce(
    (stats, entry) => nextStats(stats, entry.type),
    { ...DEFAULT_STATS },
  );
}

function nextStats(
  current: PublicActivityStats,
  eventType: PublicEventType,
): PublicActivityStats {
  if (eventType === "task_completed") {
    return {
      tasksHandled: current.tasksHandled + 1,
      tasksCompleted: current.tasksCompleted + 1,
      tasksFailed: current.tasksFailed,
    };
  }

  if (eventType === "task_failed") {
    return {
      tasksHandled: current.tasksHandled + 1,
      tasksCompleted: current.tasksCompleted,
      tasksFailed: current.tasksFailed + 1,
    };
  }

  return current;
}

function buildDeploymentFingerprint(info: DeploymentInfo): string | undefined {
  const parts = [info.commitSha, info.runId, info.deployedAt]
    .filter(Boolean)
    .map((item) => item?.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(":");
}

function buildDeploymentTitle(commitSha?: string): string {
  return commitSha
    ? `Deployment: ${commitSha.slice(0, 7)}`
    : "Deployment completed";
}

function buildDeploymentSummary(event: DeploymentInfo): string | undefined {
  const meta: string[] = [];
  if (event.actor) meta.push(`by ${event.actor}`);
  if (event.runId) meta.push(`run ${event.runId}`);
  const metaLine = meta.join(" · ");

  // Lead with the concrete commit message so the event stream reads like a
  // changelog rather than just an opaque SHA; fall back to the actor/run line.
  const message = event.commitMessage?.trim();
  if (message) {
    return metaLine ? `${message} · ${metaLine}` : message;
  }
  return metaLine || undefined;
}

function channelTitle(source: PublicSource): string {
  switch (source) {
    case "gmail":
      return "Gmail";
    case "telegram":
      return "Telegram";
    case "scheduler":
      return "Scheduler";
    case "workflow":
      return "Workflow";
    case "session":
      return "OpenCode";
  }
}

function compareChannels(left: PublicChannelState, right: PublicChannelState): number {
  const statusWeight = (status: PublicChannelStatus): number => {
    switch (status) {
      case "waiting":
        return 0;
      case "active":
        return 1;
      case "error":
        return 2;
      case "idle":
        return 3;
    }
  };

  const statusDiff = statusWeight(left.status) - statusWeight(right.status);
  if (statusDiff !== 0) return statusDiff;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function pickFocusChannel(channels: PublicChannelState[]): PublicChannelState | undefined {
  return channels.find((channel) => channel.status !== "idle") || channels[0];
}
