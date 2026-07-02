/**
 * Peek 事件擷取器。1:1 還原 dist/parsers.js 的 PeekEventExtractor。
 *
 * 注意：這塊邏輯是「依 agent 格式分流」的，目前集中在此（與 dist 行為一致）。
 * 未來若要更徹底的 registry 化，可把各 agent 的 peek 規則移進各自 agents/<name>.ts。
 */

import type { AgentId } from '../agents/types.js';
import { stripAnsi } from './ansi.js';
import { debugLog } from './debug.js';

const PEEK_TOOL_SUMMARY_MAX_LENGTH = 200;
const FORGE_EXECUTE_PATTERN = /^● \[[^\]]+\] Execute \[([^\]]*)\]\s+(.+)$/;
const FORGE_FINISHED_PATTERN = /^● \[[^\]]+\] Finished(?:\s+\S+)?\s*$/;

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

interface Summary {
  summary: string;
  summary_truncated?: boolean;
  server?: string;
}

function boundedSummary(value: unknown): Summary {
  const summary = oneLine(value);
  if (summary.length <= PEEK_TOOL_SUMMARY_MAX_LENGTH) {
    return { summary };
  }
  return {
    summary: `${summary.slice(0, PEEK_TOOL_SUMMARY_MAX_LENGTH - 3)}...`,
    summary_truncated: true,
  };
}

function normalizeMcpToolName(tool: string, explicitServer?: string): Summary | null {
  if (explicitServer) {
    return { server: explicitServer, ...boundedSummary(`${explicitServer}.${tool}`) };
  }
  const mcpDouble = tool.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpDouble) {
    return { server: mcpDouble[1], ...boundedSummary(`${mcpDouble[1]}.${mcpDouble[2]}`) };
  }
  const mcpSingle = tool.match(/^mcp_([^_]+)_(.+)$/);
  if (mcpSingle) {
    return { server: mcpSingle[1], ...boundedSummary(`${mcpSingle[1]}.${mcpSingle[2]}`) };
  }
  const acmShort = tool.match(/^acm_(.+)$/);
  if (acmShort) {
    return { server: 'acm', ...boundedSummary(`acm.${acmShort[1]}`) };
  }
  return null;
}

function buildToolSummary(
  tool: string,
  options: { command?: string; server?: string } = {}
): Summary {
  if (typeof options.command === 'string' && options.command.trim()) {
    return boundedSummary(options.command);
  }
  const mcpSummary = normalizeMcpToolName(tool, options.server);
  if (mcpSummary) {
    return mcpSummary;
  }
  return boundedSummary(tool || 'tool_call');
}

function normalizeToolStatus(
  rawStatus: unknown,
  exitCode: unknown,
  defaultStatus = 'unknown'
): string {
  if (typeof exitCode === 'number') {
    return exitCode === 0 ? 'success' : 'failed';
  }
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (['success', 'succeeded', 'ok', 'completed'].includes(status)) return 'success';
  if (['failed', 'failure', 'error', 'errored'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  return defaultStatus;
}

interface ToolCallEventParams {
  ts: string;
  phase: 'started' | 'completed';
  tool?: string;
  id?: string;
  server?: string;
  command?: string;
  status?: unknown;
  exit_code?: number;
  duration_ms?: number;
  defaultStatus?: string;
}

interface PeekEvent {
  kind: string;
  ts: string;
  [key: string]: unknown;
}

function createToolCallEvent(params: ToolCallEventParams): PeekEvent {
  const tool = params.tool || 'tool_call';
  const summary = buildToolSummary(tool, { server: params.server, command: params.command });
  const event: PeekEvent = {
    kind: 'tool_call',
    ts: params.ts,
    phase: params.phase,
    tool,
    summary: summary.summary,
  };
  if (params.id) event.id = params.id;
  if (summary.server) event.server = summary.server;
  else if (params.server) event.server = params.server;
  if (summary.summary_truncated) event.summary_truncated = true;
  if (params.phase === 'completed') {
    event.status = normalizeToolStatus(params.status, params.exit_code, params.defaultStatus);
    if (typeof params.exit_code === 'number') event.exit_code = params.exit_code;
    if (typeof params.duration_ms === 'number' && Number.isFinite(params.duration_ms)) {
      event.duration_ms = params.duration_ms;
    }
  }
  return event;
}

interface RememberedTool {
  tool: string;
  server?: string;
  summary: string;
  summary_truncated?: boolean;
}

function rememberToolCall(event: PeekEvent, memory: Map<string, RememberedTool>): void {
  if (event.kind !== 'tool_call' || !event.id) return;
  memory.set(event.id as string, {
    tool: event.tool as string,
    server: event.server as string | undefined,
    summary: event.summary as string,
    summary_truncated: event.summary_truncated as boolean | undefined,
  });
}

function createRememberedCompletion(params: {
  ts: string;
  id?: string;
  memory: Map<string, RememberedTool>;
  fallbackTool: string;
  status?: unknown;
  defaultStatus?: string;
}): PeekEvent {
  const remembered = params.id ? params.memory.get(params.id) : undefined;
  const event = createToolCallEvent({
    ts: params.ts,
    phase: 'completed',
    id: params.id,
    tool: remembered?.tool || params.fallbackTool,
    server: remembered?.server,
    status: params.status,
    defaultStatus: params.defaultStatus,
  });
  if (remembered) {
    event.summary = remembered.summary;
    if (remembered.summary_truncated) event.summary_truncated = true;
  }
  return event;
}

function extractPeekEventsFromParsedEvent(
  agent: AgentId,
  parsed: any,
  observedAt: string,
  includeToolCalls: boolean,
  memory: Map<string, RememberedTool>
): PeekEvent[] {
  if (agent === 'codex') {
    if (parsed.item?.type === 'agent_message' && typeof parsed.item.text === 'string' && parsed.item.text.trim()) {
      return [{ kind: 'message', ts: observedAt, text: parsed.item.text }];
    }
    if (parsed.msg?.type === 'agent_message' && typeof parsed.msg.message === 'string' && parsed.msg.message.trim()) {
      return [{ kind: 'message', ts: observedAt, text: parsed.msg.message }];
    }
    if (includeToolCalls && (parsed.type === 'item.started' || parsed.type === 'item.completed')) {
      const item = parsed.item;
      if (item?.type === 'command_execution') {
        const event = createToolCallEvent({
          ts: observedAt,
          phase: parsed.type === 'item.started' ? 'started' : 'completed',
          id: item.id,
          tool: 'command_execution',
          command: item.command,
          status: item.status || item.error,
          exit_code: typeof item.exit_code === 'number' ? item.exit_code : undefined,
          defaultStatus: parsed.type === 'item.completed' ? 'success' : 'unknown',
        });
        rememberToolCall(event, memory);
        return [event];
      }
      if (item?.type === 'mcp_tool_call') {
        const event = createToolCallEvent({
          ts: observedAt,
          phase: parsed.type === 'item.started' ? 'started' : 'completed',
          id: item.id,
          tool: item.tool || 'mcp_tool_call',
          server: item.server,
          status: item.status || item.error,
          defaultStatus: parsed.type === 'item.completed' ? 'success' : 'unknown',
        });
        rememberToolCall(event, memory);
        return [event];
      }
    }
    return [];
  }
  if (agent === 'claude' || agent === 'direct-api') {
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      const events: PeekEvent[] = [];
      for (const content of parsed.message.content) {
        if (content?.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
          events.push({ kind: 'message', ts: observedAt, text: content.text });
        } else if (includeToolCalls && content?.type === 'tool_use') {
          const event = createToolCallEvent({
            ts: observedAt,
            phase: 'started',
            id: content.id,
            tool: content.name || 'tool_use',
            command: content.input?.command,
          });
          rememberToolCall(event, memory);
          events.push(event);
        }
      }
      return events;
    }
    if (agent === 'claude' && includeToolCalls && parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
      const events: PeekEvent[] = [];
      for (const content of parsed.message.content) {
        if (content?.type === 'tool_result') {
          events.push(
            createRememberedCompletion({
              ts: observedAt,
              id: content.tool_use_id,
              memory,
              fallbackTool: 'tool_result',
              status: content.is_error === true ? 'failed' : undefined,
              defaultStatus: content.is_error === true ? 'failed' : 'success',
            })
          );
        }
      }
      return events;
    }
    return [];
  }
  return [];
}

interface ForgePendingTool {
  id: string;
  tool: string;
  summary: string;
  summary_truncated?: boolean;
}

export class PeekEventExtractor {
  private agent: AgentId;
  private pending = '';
  private includeToolCalls: boolean;
  private source: 'stdout' | 'stderr';
  private toolMemory = new Map<string, RememberedTool>();
  private forgePendingTool: ForgePendingTool | null = null;
  private forgeToolSequence = 0;

  constructor(agent: AgentId, options: { includeToolCalls?: boolean; source?: 'stdout' | 'stderr' } = {}) {
    this.agent = agent;
    this.includeToolCalls = options.includeToolCalls === true;
    this.source = options.source || 'stdout';
  }

  push(chunk: string, observedAt: string = new Date().toISOString()): PeekEvent[] {
    if (this.agent === 'forge' && this.source === 'stderr') return [];
    if (!chunk) return [];
    const lines = `${this.pending}${chunk}`.split(/\r?\n/);
    this.pending = lines.pop() || '';
    return this.extractLines(lines, observedAt);
  }

  flush(observedAt: string = new Date().toISOString(), options: { terminal?: boolean } = {}): PeekEvent[] {
    if (this.agent === 'forge' && this.source === 'stderr') {
      this.pending = '';
      return [];
    }
    const events: PeekEvent[] = [];
    if (this.pending) {
      if (this.agent !== 'forge' || options.terminal === true) {
        const line = this.pending;
        this.pending = '';
        events.push(...this.extractLines([line], observedAt));
      }
    }
    events.push(...this.flushForgePendingTool(observedAt, options.terminal === true));
    return events;
  }

  private extractLines(lines: string[], observedAt: string): PeekEvent[] {
    if (this.agent === 'forge') return this.extractForgeLines(lines, observedAt);
    if (this.agent === 'kiro' || this.agent === 'antigravity') {
      return this.extractPlainTextLines(lines, observedAt);
    }
    const events: PeekEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(
          ...extractPeekEventsFromParsedEvent(
            this.agent,
            JSON.parse(line),
            observedAt,
            this.includeToolCalls,
            this.toolMemory
          )
        );
      } catch {
        debugLog(`[Debug] Skipping invalid peek JSON line: ${line}`);
      }
    }
    return events;
  }

  private extractPlainTextLines(lines: string[], observedAt: string): PeekEvent[] {
    const events: PeekEvent[] = [];
    for (const line of lines) {
      const text = stripAnsi(line).trim();
      if (text) {
        events.push({ kind: 'message', ts: observedAt, text });
      }
    }
    return events;
  }

  private extractForgeLines(lines: string[], observedAt: string): PeekEvent[] {
    const events: PeekEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const summary = this.extractForgeMessage(line, 'Summary:');
      if (summary !== null) {
        events.push({ kind: 'message', ts: observedAt, text: summary });
        continue;
      }
      const completed = this.extractForgeMessage(line, 'Completed successfully:');
      if (completed !== null) {
        events.push({ kind: 'message', ts: observedAt, text: completed });
        continue;
      }
      if (this.includeToolCalls) {
        const executeMatch = line.match(FORGE_EXECUTE_PATTERN);
        if (executeMatch) {
          events.push(...this.completeForgePendingTool(observedAt));
          const [, rawTool, rawSummary] = executeMatch;
          const tool = rawTool.trim() && !/\s/.test(rawTool.trim()) ? rawTool.trim() : 'shell';
          const event = createToolCallEvent({
            ts: observedAt,
            phase: 'started',
            id: `forge_${this.forgeToolSequence++}`,
            tool,
            command: rawSummary,
          });
          this.forgePendingTool = {
            id: event.id as string,
            tool: event.tool as string,
            summary: event.summary as string,
            summary_truncated: event.summary_truncated as boolean | undefined,
          };
          events.push(event);
          continue;
        }
        if (FORGE_FINISHED_PATTERN.test(line)) {
          events.push(...this.completeForgePendingTool(observedAt));
        }
      }
    }
    return events;
  }

  private extractForgeMessage(line: string, prefix: string): string | null {
    if (!line.startsWith(prefix)) return null;
    const text = line.slice(prefix.length).trim();
    return text || null;
  }

  private completeForgePendingTool(observedAt: string): PeekEvent[] {
    if (!this.forgePendingTool) return [];
    const pending = this.forgePendingTool;
    this.forgePendingTool = null;
    const event = createToolCallEvent({
      ts: observedAt,
      phase: 'completed',
      id: pending.id,
      tool: pending.tool,
      status: 'unknown',
      defaultStatus: 'unknown',
    });
    event.summary = pending.summary;
    if (pending.summary_truncated) event.summary_truncated = true;
    return [event];
  }

  private flushForgePendingTool(observedAt: string, terminal: boolean): PeekEvent[] {
    if (this.agent !== 'forge' || !terminal) return [];
    return this.completeForgePendingTool(observedAt);
  }
}
