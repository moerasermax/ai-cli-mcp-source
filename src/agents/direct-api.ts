/**
 * Direct OpenAI-compatible API agent.
 *
 * This agent does not start a CLI process. process-service calls runDirect()
 * in the current Node.js process and tracks it with the same PID/result API.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative as pathRelative, resolve as pathResolve } from 'node:path';
import type {
  AgentDefinition,
  BuildCommandInput,
  BuiltCommand,
  DirectRunIO,
} from './types.js';
import { debugLog } from '../core/debug.js';

const DIRECT_API_MODELS = [
  'or-<model>',
  'ds-<model>',
  '<provider>-<model>',
  'or-qwen/qwen3.7-plus',
] as const;

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const IMAGE_MARKER = /\[image:([^\]\r\n]+)\]/g;
const NO_TOOLS_MARKER = /^\s*\[no-tools\]\s*/i;
const MAX_TOOL_LOOP_ITERATIONS = 30;
const MAX_API_CALLS = 30;
const MAX_TOOL_OUTPUT_CHARS = 10000;
const TOOL_OUTPUT_PREVIEW_CHARS = 200;
const BASH_TIMEOUT_MS = 30000;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace. Supports line offset and limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to read, relative to the workspace.' },
          offset: { type: 'number', description: 'Optional zero-based line offset.' },
          limit: { type: 'number', description: 'Optional maximum number of lines to return.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file in the workspace, creating parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to write, relative to the workspace.' },
          content: { type: 'string', description: 'Complete file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents in the workspace using ripgrep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to search for.' },
          path: { type: 'string', description: 'Directory or file path to search under.' },
          glob: { type: 'string', description: 'Optional ripgrep glob filter.' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find file names in the workspace using ripgrep file listing.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Ripgrep glob pattern.' },
          path: { type: 'string', description: 'Optional directory path to list under.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list, relative to the workspace.' },
        },
        required: ['path'],
      },
    },
  },
] as const;

const PROVIDER_PREFIX_ALIASES: Record<string, string> = {
  or: 'openrouter',
  ds: 'dashscope',
};

const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface ProviderConfig {
  base_url: string;
  api_key: string;
}

interface ProvidersFile {
  providers: Record<string, ProviderConfig>;
}

interface DirectApiModelSelection {
  providerName: string;
  modelName: string;
}

interface TextContentPart {
  type: 'text';
  text: string;
}

interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

type ChatContentPart = TextContentPart | ImageContentPart;
type ChatContent = string | ChatContentPart[];

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: ChatContent | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface SessionFile {
  id: string;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  tokens?: Record<string, number>;
  cost?: unknown;
}

interface CompletionUsage {
  [key: string]: unknown;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface StreamState {
  sessionId: string;
  providerName: string;
  modelName: string;
  assistantText: string;
  reasoningText: string;
  usage?: CompletionUsage;
  cost?: unknown;
  finishReason?: string;
}

interface StreamToolCallAccumulator {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface CompletionTurn {
  assistantText: string;
  reasoningText: string;
  toolCallAccumulators: StreamToolCallAccumulator[];
  toolCalls: ChatToolCall[];
  finishReason?: string;
}

interface ToolExecutionResult {
  status: 'completed' | 'failed';
  output: string;
}

function providersPath(): string {
  return process.env.AI_CLI_PROVIDERS_PATH ||
    join(homedir(), '.local', 'share', 'ai-cli', 'providers.json');
}

function openCodeAuthPath(): string {
  return process.env.AI_CLI_OPENCODE_AUTH_PATH ||
    join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeProviderConfig(providerName: string, value: unknown): ProviderConfig | null {
  const record = asRecord(value);
  if (!record) return null;
  const apiKey = record.api_key || record.key || record.token;
  const baseUrl = record.base_url || record.baseURL || DEFAULT_PROVIDER_BASE_URLS[providerName];
  if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  return { base_url: baseUrl.trim().replace(/\/+$/, ''), api_key: apiKey.trim() };
}

function migrateOpenCodeAuth(rawAuth: unknown): ProvidersFile {
  const auth = asRecord(rawAuth);
  const providers: Record<string, ProviderConfig> = {};
  if (!auth) return { providers };
  for (const [providerName, rawProvider] of Object.entries(auth)) {
    const normalized = normalizeProviderConfig(providerName, rawProvider);
    if (normalized) {
      providers[providerName] = normalized;
    }
  }
  return { providers };
}

function ensureProvidersConfigMigrated(): void {
  const targetPath = providersPath();
  if (existsSync(targetPath)) return;
  const sourcePath = openCodeAuthPath();
  if (!existsSync(sourcePath)) return;

  let migrated: ProvidersFile;
  try {
    migrated = migrateOpenCodeAuth(JSON.parse(readFileSync(sourcePath, 'utf-8')));
  } catch (error) {
    throw new Error(`Failed to migrate OpenCode auth.json: ${(error as Error).message}`);
  }
  if (Object.keys(migrated.providers).length === 0) return;

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf-8');
  console.error(`[direct-api] Migrated OpenCode auth to ${targetPath}.`);
}

export function loadProvidersConfig(): ProvidersFile {
  ensureProvidersConfigMigrated();
  const targetPath = providersPath();
  if (!existsSync(targetPath)) {
    return { providers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(targetPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to read providers.json at ${targetPath}: ${(error as Error).message}`);
  }
  const root = asRecord(parsed);
  const rawProviders = asRecord(root?.providers);
  if (!rawProviders) {
    throw new Error(`Invalid providers.json at ${targetPath}: missing "providers" object.`);
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [providerName, rawProvider] of Object.entries(rawProviders)) {
    const normalized = normalizeProviderConfig(providerName, rawProvider);
    if (!normalized) {
      throw new Error(
        `Invalid providers.json at ${targetPath}: provider "${providerName}" requires base_url and api_key.`
      );
    }
    providers[providerName] = normalized;
  }
  return { providers };
}

export function listConfiguredProviderKeys(): string[] {
  return Object.keys(loadProvidersConfig().providers);
}

function getProviderConfig(providerName: string): ProviderConfig {
  const config = loadProvidersConfig();
  const provider = config.providers[providerName];
  if (!provider) {
    throw new Error(
      `Provider "${providerName}" not found in ${providersPath()}. Add it under providers.${providerName}.`
    );
  }
  return provider;
}

function tryKnownProviderAlias(rawModel: string): DirectApiModelSelection | null {
  for (const [prefix, providerName] of Object.entries(PROVIDER_PREFIX_ALIASES)) {
    const marker = `${prefix}-`;
    if (!rawModel.startsWith(marker)) continue;
    const modelName = rawModel.slice(marker.length);
    if (!modelName) {
      throw new Error(`Invalid direct-api model. Expected ${prefix}-<model>.`);
    }
    return { providerName, modelName };
  }
  return null;
}

function tryConfiguredProviderPrefix(rawModel: string): DirectApiModelSelection | null {
  if (!existsSync(providersPath())) {
    return null;
  }
  let providerKeys: string[];
  try {
    providerKeys = listConfiguredProviderKeys();
  } catch (error) {
    debugLog(`[Debug] Skipping configured provider prefix routing: ${(error as Error).message}`);
    return null;
  }
  const sortedKeys = providerKeys.sort((a, b) => b.length - a.length);
  for (const providerName of sortedKeys) {
    const marker = `${providerName}-`;
    if (!rawModel.startsWith(marker)) continue;
    const modelName = rawModel.slice(marker.length);
    if (!modelName) {
      throw new Error(`Invalid direct-api model. Expected ${providerName}-<model>.`);
    }
    return { providerName, modelName };
  }
  return null;
}

export function resolveDirectApiModel(rawModel: string): DirectApiModelSelection | null {
  const trimmed = rawModel.trim();
  if (rawModel !== trimmed) {
    const knownPrefix = Object.keys(PROVIDER_PREFIX_ALIASES).some((prefix) =>
      trimmed.startsWith(`${prefix}-`)
    );
    if (knownPrefix) {
      throw new Error('Invalid direct-api model. Do not include leading or trailing whitespace.');
    }
  }
  const known = tryKnownProviderAlias(rawModel);
  if (known) return known;
  return tryConfiguredProviderPrefix(rawModel);
}

function buildCommand(input: BuildCommandInput): BuiltCommand {
  if (!input.providerName || !input.providerModel) {
    throw new Error('direct-api requires a provider-prefixed model such as or-qwen/qwen3.7-plus.');
  }
  const provider =
    input.providerBaseUrl && input.providerApiKey
      ? { base_url: input.providerBaseUrl, api_key: input.providerApiKey }
      : getProviderConfig(input.providerName);
  return {
    cliPath: '',
    args: [],
    cwd: input.cwd,
    agent: 'direct-api',
    prompt: input.prompt,
    resolvedModel: input.providerModel,
    sessionId: input.sessionId,
    directApi: {
      providerName: input.providerName,
      modelName: input.providerModel,
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
    },
  };
}

function parseOutput(stdout: string): unknown {
  if (!stdout.trim()) return null;
  let sessionId: string | null = null;
  let message = '';
  let tokens: unknown;
  let cost: unknown;
  let sessionPath: string | undefined;
  let finishReason: string | undefined;
  let reasoning: string | undefined;
  const toolsMap = new Map<string, { tool: string; input: unknown; status?: string; output_preview?: string }>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed.session_id === 'string') {
      sessionId = parsed.session_id;
    }
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      for (const content of parsed.message.content) {
        if (content?.type === 'text' && typeof content.text === 'string') {
          message += content.text;
        }
      }
    }
    if (parsed.type === 'reasoning' && typeof parsed.delta === 'string') {
      reasoning = `${reasoning || ''}${parsed.delta}`;
    }
    if (parsed.type === 'message' && typeof parsed.content === 'string') {
      message = parsed.content;
    }
    if (parsed.type === 'tool_use' && typeof parsed.tool === 'string') {
      const key = typeof parsed.id === 'string' ? parsed.id : `${parsed.tool}:${toolsMap.size}`;
      toolsMap.set(key, {
        tool: parsed.tool,
        input: parsed.input,
        status: typeof parsed.status === 'string' ? parsed.status : undefined,
        output_preview: typeof parsed.output_preview === 'string' ? parsed.output_preview : undefined,
      });
    }
    if (parsed.type === 'result') {
      if (typeof parsed.result === 'string') {
        message = parsed.result;
      }
      tokens = parsed.tokens;
      cost = parsed.cost;
      sessionPath = typeof parsed.session_path === 'string' ? parsed.session_path : undefined;
      finishReason = typeof parsed.finish_reason === 'string' ? parsed.finish_reason : undefined;
    }
  }

  const tools = Array.from(toolsMap.values());
  if (!message && !sessionId && !tokens && cost === undefined && tools.length === 0) {
    return null;
  }
  return {
    message,
    tokens,
    cost,
    session_id: sessionId,
    sessionPath,
    finish_reason: finishReason,
    reasoning,
    tools: tools.length > 0 ? tools : undefined,
  };
}

function emitJsonLine(write: (chunk: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function truncateText(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n[truncated]';
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function toolOutputPreview(output: string): string {
  return truncateText(output, TOOL_OUTPUT_PREVIEW_CHARS);
}

function requireObject(value: unknown, toolName: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${toolName} arguments must be an object.`);
  }
  return record;
}

function requireStringArg(args: Record<string, unknown>, key: string, toolName: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`${toolName}.${key} must be a string.`);
  }
  return value;
}

function optionalLineNumberArg(args: Record<string, unknown>, key: string, toolName: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${toolName}.${key} must be a non-negative integer.`);
  }
  return value;
}

function resolveSandboxPath(workFolder: string, toolPath = '.'): string {
  const root = pathResolve(workFolder);
  const target = pathResolve(root, toolPath);
  const relative = pathRelative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !isAbsolute(relative))) {
    return target;
  }
  throw new Error(`Path is outside the workspace: ${toolPath}`);
}

function sandboxRelativePath(workFolder: string, toolPath = '.'): string {
  const root = pathResolve(workFolder);
  const target = resolveSandboxPath(root, toolPath);
  const relative = pathRelative(root, target);
  return relative || '.';
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/(["^&|<>%])/g, '^$1')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stringifyExecOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return typeof value === 'string' ? value : '';
}

function formatExecError(error: unknown): string {
  const err = error as Error & {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number;
    signal?: NodeJS.Signals | string;
  };
  const parts: string[] = [];
  if (typeof err.status === 'number') parts.push(`Exit code: ${err.status}`);
  if (err.signal) parts.push(`Signal: ${err.signal}`);
  const stdout = stringifyExecOutput(err.stdout).trim();
  const stderr = stringifyExecOutput(err.stderr).trim();
  if (stdout) parts.push(`STDOUT:\n${stdout}`);
  if (stderr) parts.push(`STDERR:\n${stderr}`);
  if (parts.length === 0 && err.message) parts.push(err.message);
  return parts.join('\n\n') || 'Command failed.';
}

function execRg(command: string, workFolder: string, noMatchOk = true): string {
  try {
    return execSync(command, {
      cwd: pathResolve(workFolder),
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as Error & { stdout?: Buffer | string; status?: number };
    const stdout = stringifyExecOutput(err.stdout);
    if (noMatchOk && err.status === 1) return stdout;
    throw error;
  }
}

function executeTool(name: string, rawArgs: unknown, workFolder: string): ToolExecutionResult {
  try {
    const args = requireObject(rawArgs, name);
    if (name === 'read_file') {
      const targetPath = resolveSandboxPath(workFolder, requireStringArg(args, 'path', name));
      const offset = optionalLineNumberArg(args, 'offset', name);
      const limit = optionalLineNumberArg(args, 'limit', name);
      const content = readFileSync(targetPath, 'utf-8');
      if (offset === undefined && limit === undefined) {
        return { status: 'completed', output: truncateText(content) };
      }
      const lines = content.split(/\r?\n/);
      const start = offset ?? 0;
      const end = limit === undefined ? undefined : start + limit;
      return { status: 'completed', output: truncateText(lines.slice(start, end).join('\n')) };
    }
    if (name === 'write_file') {
      const targetPath = resolveSandboxPath(workFolder, requireStringArg(args, 'path', name));
      const content = requireStringArg(args, 'content', name);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content, 'utf-8');
      return { status: 'completed', output: `Wrote ${content.length} chars to ${sandboxRelativePath(workFolder, targetPath)}.` };
    }
    if (name === 'grep') {
      const pattern = requireStringArg(args, 'pattern', name);
      const searchPath = sandboxRelativePath(workFolder, requireStringArg(args, 'path', name));
      const glob = args.glob === undefined ? undefined : requireStringArg(args, 'glob', name);
      const globPart = glob ? ` --glob ${shellQuote(glob)}` : '';
      const command = `rg --line-number --color never${globPart} -- ${shellQuote(pattern)} ${shellQuote(searchPath)}`;
      const output = execRg(command, workFolder, true);
      return { status: 'completed', output: truncateText(output) };
    }
    if (name === 'glob') {
      const pattern = requireStringArg(args, 'pattern', name);
      const searchPath = sandboxRelativePath(workFolder, typeof args.path === 'string' ? args.path : '.');
      const command = `rg --files --glob ${shellQuote(pattern)} ${shellQuote(searchPath)}`;
      const output = execRg(command, workFolder, true);
      return { status: 'completed', output: truncateText(output) };
    }
    if (name === 'bash') {
      const command = requireStringArg(args, 'command', name);
      try {
        const output = execSync(command, {
          cwd: pathResolve(workFolder),
          encoding: 'utf-8',
          timeout: BASH_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { status: 'completed', output: truncateText(output) };
      } catch (error) {
        return { status: 'failed', output: truncateText(formatExecError(error)) };
      }
    }
    if (name === 'list_dir') {
      const targetPath = resolveSandboxPath(workFolder, requireStringArg(args, 'path', name));
      const entries = readdirSync(targetPath, { withFileTypes: true })
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
        .sort((a, b) => a.localeCompare(b));
      return { status: 'completed', output: truncateText(entries.join('\n')) };
    }
    return { status: 'failed', output: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      status: 'failed',
      output: truncateText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function resolveSessionId(sessionId: string | undefined): string {
  if (sessionId) {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new Error(`Invalid direct-api session_id: ${sessionId}`);
    }
    return sessionId;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}_${random}`;
}

function resolveSessionPath(workFolder: string, sessionId: string): string {
  return join(workFolder, '.tmp', 'api_sessions', `ses_${sessionId}.json`);
}

function readSession(sessionPath: string): SessionFile | null {
  if (!existsSync(sessionPath)) return null;
  const parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')) as SessionFile;
  if (!Array.isArray(parsed.messages)) {
    throw new Error(`Invalid direct-api session file: ${sessionPath}`);
  }
  return parsed;
}

function saveSession(params: {
  sessionPath: string;
  existing: SessionFile | null;
  sessionId: string;
  providerName: string;
  modelName: string;
  messages: ChatMessage[];
  tokens?: Record<string, number>;
  cost?: unknown;
}): void {
  const now = new Date().toISOString();
  const session: SessionFile = {
    id: params.sessionId,
    provider: params.providerName,
    model: params.modelName,
    created_at: params.existing?.created_at || now,
    updated_at: now,
    messages: params.messages,
    tokens: params.tokens,
    cost: params.cost,
  };
  mkdirSync(dirname(params.sessionPath), { recursive: true });
  writeFileSync(params.sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
}

function stripImageMarkers(prompt: string, imagePaths: string[]): string {
  return prompt.replace(IMAGE_MARKER, (_match, rawPath: string) => {
    const imagePath = rawPath.trim();
    if (imagePath) imagePaths.push(imagePath);
    return '';
  });
}

function normalizeImagePath(rawPath: string, cwd: string): string {
  const unquoted = rawPath.replace(/^['"]|['"]$/g, '');
  if (unquoted === '~') return homedir();
  if (unquoted.startsWith('~/') || unquoted.startsWith('~\\')) {
    return join(homedir(), unquoted.slice(2));
  }
  return isAbsolute(unquoted) ? unquoted : pathResolve(cwd, unquoted);
}

async function buildImagePart(rawPath: string, cwd: string): Promise<ImageContentPart> {
  const filePath = normalizeImagePath(rawPath, cwd);
  const ext = extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported image type for ${filePath}. Supported: png, jpg, jpeg, webp, gif.`);
  }
  const data = await readFile(filePath);
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${data.toString('base64')}` },
  };
}

async function buildUserMessage(prompt: string, cwd: string): Promise<ChatMessage> {
  const imagePaths: string[] = [];
  const text = stripImageMarkers(prompt, imagePaths).trim();
  if (imagePaths.length === 0) {
    return { role: 'user', content: prompt };
  }
  const content: ChatContentPart[] = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const imagePath of imagePaths) {
    content.push(await buildImagePart(imagePath, cwd));
  }
  return { role: 'user', content };
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const part = asRecord(item);
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  const record = asRecord(value);
  return typeof record?.text === 'string' ? record.text : '';
}

function extractReasoning(delta: Record<string, unknown>): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const value = delta[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function normalizeTokens(usage: CompletionUsage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const tokens: Record<string, number> = {};
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof input === 'number') tokens.input = input;
  if (typeof output === 'number') tokens.output = output;
  if (typeof reasoning === 'number') tokens.reasoning = reasoning;
  if (typeof cached === 'number') tokens.cached = cached;
  if (typeof usage.total_tokens === 'number') tokens.total = usage.total_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function normalizeCost(value: unknown): unknown {
  const record = asRecord(value);
  const direct = record?.cost ?? record?.total_cost ?? record?.totalCost;
  if (typeof direct === 'number' || typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') return direct;
  return undefined;
}

function redactApiKey(text: string, apiKey: string): string {
  return text.includes(apiKey) ? text.split(apiKey).join('[redacted]') : text;
}

function createEmptyTurn(): CompletionTurn {
  return {
    assistantText: '',
    reasoningText: '',
    toolCallAccumulators: [],
    toolCalls: [],
  };
}

function mergeCompletionUsage(
  current: CompletionUsage | undefined,
  next: CompletionUsage
): CompletionUsage {
  const merged: CompletionUsage = { ...(current || {}) };
  const numericKeys = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'input_tokens',
    'output_tokens',
    'reasoning_tokens',
  ] as const;
  for (const key of numericKeys) {
    const value = next[key];
    if (typeof value === 'number') {
      const existing = typeof merged[key] === 'number' ? merged[key] as number : 0;
      merged[key] = existing + value;
    }
  }
  const cached = next.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number') {
    const existing = merged.prompt_tokens_details?.cached_tokens || 0;
    merged.prompt_tokens_details = {
      ...(merged.prompt_tokens_details || {}),
      cached_tokens: existing + cached,
    };
  }
  const reasoning = next.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number') {
    const existing = merged.completion_tokens_details?.reasoning_tokens || 0;
    merged.completion_tokens_details = {
      ...(merged.completion_tokens_details || {}),
      reasoning_tokens: existing + reasoning,
    };
  }
  return merged;
}

function mergeCost(current: unknown, next: unknown): unknown {
  if (next === undefined) return current;
  if (typeof current === 'number' && typeof next === 'number') return current + next;
  return next;
}

function captureUsageAndCost(parsed: any, state: StreamState): void {
  if (parsed?.usage) {
    state.usage = mergeCompletionUsage(state.usage, parsed.usage as CompletionUsage);
    state.cost = mergeCost(state.cost, normalizeCost(parsed.usage));
  }
  state.cost = mergeCost(state.cost, normalizeCost(parsed));
}

function appendToolCallDeltas(delta: Record<string, unknown>, turn: CompletionTurn): void {
  if (!Array.isArray(delta.tool_calls)) return;
  for (const rawCall of delta.tool_calls) {
    const call = asRecord(rawCall);
    if (!call) continue;
    const index = typeof call.index === 'number' ? call.index : turn.toolCallAccumulators.length;
    const accumulator = turn.toolCallAccumulators[index] || {};
    if (typeof call.id === 'string') accumulator.id = call.id;
    if (typeof call.type === 'string') accumulator.type = call.type;
    const fn = asRecord(call.function);
    if (fn) {
      accumulator.function = accumulator.function || {};
      if (typeof fn.name === 'string') accumulator.function.name = fn.name;
      if (typeof fn.arguments === 'string') {
        accumulator.function.arguments = `${accumulator.function.arguments || ''}${fn.arguments}`;
      }
    }
    turn.toolCallAccumulators[index] = accumulator;
  }
}

function normalizeToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  for (const rawCall of value) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (!call || !name) continue;
    calls.push({
      id: typeof call.id === 'string' ? call.id : `call_${calls.length}`,
      type: 'function',
      function: {
        name,
        arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
      },
    });
  }
  return calls;
}

function finalizeStreamToolCalls(turn: CompletionTurn): void {
  if (turn.toolCalls.length > 0) return;
  turn.toolCalls = normalizeToolCalls(
    turn.toolCallAccumulators.map((call, index) => ({
      id: call.id || `call_${index}`,
      type: call.type || 'function',
      function: {
        name: call.function?.name || '',
        arguments: call.function?.arguments || '',
      },
    }))
  );
}

function handleCompletionChunk(parsed: any, state: StreamState, turn: CompletionTurn, io: DirectRunIO): void {
  captureUsageAndCost(parsed, state);
  if (!Array.isArray(parsed?.choices)) return;
  for (const choice of parsed.choices) {
    const delta = asRecord(choice?.delta);
    if (delta) {
      const textDelta = extractText(delta.content);
      if (textDelta) {
        state.assistantText += textDelta;
        turn.assistantText += textDelta;
        emitJsonLine(io.stdout, {
          type: 'assistant',
          session_id: state.sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: textDelta }] },
        });
      }
      const reasoningDelta = extractReasoning(delta);
      if (reasoningDelta) {
        state.reasoningText += reasoningDelta;
        turn.reasoningText += reasoningDelta;
        emitJsonLine(io.stdout, {
          type: 'reasoning',
          session_id: state.sessionId,
          delta: reasoningDelta,
        });
      }
      appendToolCallDeltas(delta, turn);
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
      turn.finishReason = choice.finish_reason;
    }
  }
}

function handleCompletionObject(parsed: any, state: StreamState, turn: CompletionTurn, io: DirectRunIO): void {
  captureUsageAndCost(parsed, state);
  if (!Array.isArray(parsed?.choices)) return;
  const textParts: string[] = [];
  for (const choice of parsed.choices) {
    const message = asRecord(choice?.message);
    if (message) {
      const text = extractText(message.content);
      if (text) textParts.push(text);
      const reasoning = extractReasoning(message);
      if (reasoning) {
        state.reasoningText += reasoning;
        turn.reasoningText += reasoning;
      }
      turn.toolCalls.push(...normalizeToolCalls(message.tool_calls));
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
      turn.finishReason = choice.finish_reason;
    }
  }
  const text = textParts.join('');
  if (text) {
    state.assistantText += text;
    turn.assistantText += text;
    emitJsonLine(io.stdout, {
      type: 'assistant',
      session_id: state.sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  }
}

async function consumeResponse(response: Response, state: StreamState, io: DirectRunIO): Promise<CompletionTurn> {
  const turn = createEmptyTurn();
  const reader = response.body?.getReader();
  if (!reader) {
    const parsed = await response.json();
    handleCompletionObject(parsed, state, turn, io);
    finalizeStreamToolCalls(turn);
    return turn;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let rawBody = '';
  let sawSseData = false;
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    sawSseData = true;
    try {
      handleCompletionChunk(JSON.parse(data), state, turn, io);
    } catch (error) {
      debugLog(`[Debug] Skipping invalid direct-api stream chunk: ${(error as Error).message}`);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawBody += chunk;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  }
  const finalChunk = decoder.decode();
  if (finalChunk) {
    rawBody += finalChunk;
    buffer += finalChunk;
  }
  if (buffer) {
    for (const line of buffer.split(/\r?\n/)) {
      processLine(line);
    }
  }
  if (!sawSseData && rawBody.trim()) {
    handleCompletionObject(JSON.parse(rawBody), state, turn, io);
  }
  finalizeStreamToolCalls(turn);
  return turn;
}

function buildAssistantMessage(turn: CompletionTurn): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: turn.assistantText || (turn.toolCalls.length > 0 ? null : ''),
  };
  if (turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls;
  }
  return message;
}

function parseToolArguments(toolCall: ChatToolCall): { ok: true; value: unknown } | { ok: false; message: string } {
  const raw = toolCall.function.arguments.trim();
  if (!raw) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      message: `Invalid JSON arguments for ${toolCall.function.name}: ${(error as Error).message}`,
    };
  }
}

async function requestCompletion(params: {
  url: string;
  apiKey: string;
  modelName: string;
  messages: ChatMessage[];
  toolsEnabled: boolean;
  state: StreamState;
  io: DirectRunIO;
}): Promise<CompletionTurn> {
  const requestBody: Record<string, unknown> = {
    model: params.modelName,
    messages: params.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.toolsEnabled) {
    requestBody.tools = TOOL_DEFINITIONS;
  }

  const response = await fetch(params.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: params.io.signal,
  });

  if (!response.ok) {
    const errorText = redactApiKey(await response.text(), params.apiKey);
    params.io.stderr(`[direct-api] HTTP ${response.status}: ${errorText}\n`);
    throw new Error(`direct-api request failed with HTTP ${response.status}`);
  }

  return consumeResponse(response, params.state, params.io);
}

async function runDirect(cmd: BuiltCommand, io: DirectRunIO): Promise<void> {
  const config = cmd.directApi;
  if (!config) {
    throw new Error('Missing direct-api command configuration.');
  }

  const sessionId = resolveSessionId(cmd.sessionId);
  const sessionPath = resolveSessionPath(cmd.cwd, sessionId);
  const existing = readSession(sessionPath);
  const toolsEnabled = !NO_TOOLS_MARKER.test(cmd.prompt);
  const prompt = toolsEnabled ? cmd.prompt : cmd.prompt.replace(NO_TOOLS_MARKER, '');
  const userMessage = await buildUserMessage(prompt, cmd.cwd);
  const messages = [...(existing?.messages || []), userMessage];
  const state: StreamState = {
    sessionId,
    providerName: config.providerName,
    modelName: config.modelName,
    assistantText: '',
    reasoningText: '',
  };

  emitJsonLine(io.stdout, {
    type: 'session.started',
    session_id: sessionId,
    provider: config.providerName,
    model: config.modelName,
    tools_enabled: toolsEnabled,
  });

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let reachedLimit = true;
  let apiCalls = 0;
  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS && apiCalls < MAX_API_CALLS; iteration++) {
    apiCalls += 1;
    const turn = await requestCompletion({
      url,
      apiKey: config.apiKey,
      modelName: config.modelName,
      messages,
      toolsEnabled,
      state,
      io,
    });
    messages.push(buildAssistantMessage(turn));
    if (!toolsEnabled || turn.toolCalls.length === 0) {
      reachedLimit = false;
      break;
    }
    for (const toolCall of turn.toolCalls) {
      const parsedArgs = parseToolArguments(toolCall);
      const result = parsedArgs.ok
        ? executeTool(toolCall.function.name, parsedArgs.value, cmd.cwd)
        : { status: 'failed' as const, output: truncateText(parsedArgs.message) };
      emitJsonLine(io.stdout, {
        type: 'tool_use',
        session_id: sessionId,
        id: toolCall.id,
        tool: toolCall.function.name,
        input: parsedArgs.ok ? parsedArgs.value : { arguments: toolCall.function.arguments },
        status: result.status,
        output_preview: toolOutputPreview(result.output),
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.output,
      });
    }
  }

  if (reachedLimit) {
    state.finishReason = 'tool_loop_limit';
    io.stderr(`[direct-api] Reached maximum tool/API calls (${MAX_TOOL_LOOP_ITERATIONS}).\n`);
  }

  const tokens = normalizeTokens(state.usage);
  saveSession({
    sessionPath,
    existing,
    sessionId,
    providerName: config.providerName,
    modelName: config.modelName,
    messages,
    tokens,
    cost: state.cost,
  });

  emitJsonLine(io.stdout, {
    type: 'result',
    session_id: sessionId,
    provider: config.providerName,
    model: config.modelName,
    result: state.assistantText,
    tokens,
    cost: state.cost,
    finish_reason: state.finishReason,
    session_path: sessionPath,
  });
}

export const directApiAgent: AgentDefinition = {
  id: 'direct-api',
  models: DIRECT_API_MODELS,
  matchesModel: (model) => model.startsWith('or-') || model.startsWith('ds-'),
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for direct-api.',
  },
  buildCommand,
  parseOutput,
  spawnMode: 'direct',
  runDirect,
};
