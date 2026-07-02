/**
 * Direct OpenAI-compatible API agent.
 *
 * This agent does not start a CLI process. process-service calls runDirect()
 * in the current Node.js process and tracks it with the same PID/result API.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path';
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

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: ChatContent;
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

  if (!message && !sessionId && !tokens && cost === undefined) {
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
  };
}

function emitJsonLine(write: (chunk: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
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

function handleCompletionChunk(parsed: any, state: StreamState, io: DirectRunIO): void {
  if (parsed?.usage) {
    state.usage = parsed.usage as CompletionUsage;
    state.cost = normalizeCost(parsed.usage);
  }
  if (normalizeCost(parsed) !== undefined) {
    state.cost = normalizeCost(parsed);
  }
  if (!Array.isArray(parsed?.choices)) return;
  for (const choice of parsed.choices) {
    const delta = asRecord(choice?.delta);
    if (delta) {
      const textDelta = extractText(delta.content);
      if (textDelta) {
        state.assistantText += textDelta;
        emitJsonLine(io.stdout, {
          type: 'assistant',
          session_id: state.sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: textDelta }] },
        });
      }
      const reasoningDelta = extractReasoning(delta);
      if (reasoningDelta) {
        state.reasoningText += reasoningDelta;
        emitJsonLine(io.stdout, {
          type: 'reasoning',
          session_id: state.sessionId,
          delta: reasoningDelta,
        });
      }
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
    }
  }
}

function handleCompletionObject(parsed: any, state: StreamState, io: DirectRunIO): void {
  if (parsed?.usage) {
    state.usage = parsed.usage as CompletionUsage;
    state.cost = normalizeCost(parsed.usage);
  }
  if (normalizeCost(parsed) !== undefined) {
    state.cost = normalizeCost(parsed);
  }
  if (!Array.isArray(parsed?.choices)) return;
  const textParts: string[] = [];
  for (const choice of parsed.choices) {
    const message = asRecord(choice?.message);
    if (message) {
      const text = extractText(message.content);
      if (text) textParts.push(text);
      const reasoning = extractReasoning(message);
      if (reasoning) state.reasoningText += reasoning;
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
    }
  }
  const text = textParts.join('');
  if (text) {
    state.assistantText += text;
    emitJsonLine(io.stdout, {
      type: 'assistant',
      session_id: state.sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  }
}

async function consumeResponse(response: Response, state: StreamState, io: DirectRunIO): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    const parsed = await response.json();
    handleCompletionObject(parsed, state, io);
    return;
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
      handleCompletionChunk(JSON.parse(data), state, io);
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
    handleCompletionObject(JSON.parse(rawBody), state, io);
  }
}

async function runDirect(cmd: BuiltCommand, io: DirectRunIO): Promise<void> {
  const config = cmd.directApi;
  if (!config) {
    throw new Error('Missing direct-api command configuration.');
  }

  const sessionId = resolveSessionId(cmd.sessionId);
  const sessionPath = resolveSessionPath(cmd.cwd, sessionId);
  const existing = readSession(sessionPath);
  const userMessage = await buildUserMessage(cmd.prompt, cmd.cwd);
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
  });

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: io.signal,
  });

  if (!response.ok) {
    const errorText = redactApiKey(await response.text(), config.apiKey);
    io.stderr(`[direct-api] HTTP ${response.status}: ${errorText}\n`);
    throw new Error(`direct-api request failed with HTTP ${response.status}`);
  }

  await consumeResponse(response, state, io);

  const tokens = normalizeTokens(state.usage);
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: state.assistantText,
  };
  const finalMessages = [...messages, assistantMessage];
  saveSession({
    sessionPath,
    existing,
    sessionId,
    providerName: config.providerName,
    modelName: config.modelName,
    messages: finalMessages,
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
