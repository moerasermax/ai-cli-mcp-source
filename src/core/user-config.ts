/**
 * 使用者持久化設定。放在 providers.json 同一層目錄：
 *   ~/.local/share/ai-cli/config.json
 *
 * 目前支援：
 *   {
 *     "defaultReasoningEffort": "medium",
 *     "aliasReasoningEffort": { "claude-ultra": "medium", "codex-ultra": "medium" }
 *   }
 *
 * 設計原則：
 * - 設定檔不存在／壞掉 → 靜默退回內建預設，永遠不讓 run 因為設定檔而失敗。
 * - 以 mtime 快取，改檔後不必重啟 MCP server。
 * - 環境變數 AI_CLI_DEFAULT_REASONING_EFFORT 優先於設定檔（方便臨時覆蓋／測試）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_REASONING_EFFORTS } from './reasoning.js';
import { debugLog } from './debug.js';

export interface UserConfig {
  /** 所有支援 reasoning 的 agent 在未指定時套用的預設值。 */
  defaultReasoningEffort?: string;
  /** 針對特定 model/alias 的覆蓋值，優先於 defaultReasoningEffort。 */
  aliasReasoningEffort?: Record<string, string>;
}

export const CONFIG_DIR = join(homedir(), '.local', 'share', 'ai-cli');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** 設定檔不存在時的內建行為（1:1 沿用原本 dist 的 ultra alias 預設）。 */
export const BUILTIN_ALIAS_REASONING: Record<string, string> = {
  'claude-ultra': 'max',
  'codex-ultra': 'xhigh',
};

let cache: { mtimeMs: number; config: UserConfig } | null = null;

function normalizeEffort(value: unknown, source: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!ALLOWED_REASONING_EFFORTS.has(normalized)) {
    debugLog(`[Config] Ignoring invalid reasoning effort "${value}" from ${source}`);
    return undefined;
  }
  return normalized;
}

/** 讀取（並快取）設定檔。任何錯誤都退回空設定。 */
export function loadUserConfig(): UserConfig {
  let mtimeMs: number;
  try {
    if (!existsSync(CONFIG_PATH)) {
      cache = null;
      return {};
    }
    mtimeMs = statSync(CONFIG_PATH).mtimeMs;
  } catch (error) {
    debugLog(`[Config] Failed to stat ${CONFIG_PATH}: ${(error as Error).message}`);
    return {};
  }

  if (cache && cache.mtimeMs === mtimeMs) {
    return cache.config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (error) {
    debugLog(`[Config] Failed to parse ${CONFIG_PATH}: ${(error as Error).message}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    debugLog(`[Config] ${CONFIG_PATH} is not a JSON object; ignoring`);
    return {};
  }

  const raw = parsed as Record<string, unknown>;
  const config: UserConfig = {};

  const defaultEffort = normalizeEffort(raw.defaultReasoningEffort, 'defaultReasoningEffort');
  if (defaultEffort) {
    config.defaultReasoningEffort = defaultEffort;
  }

  if (raw.aliasReasoningEffort && typeof raw.aliasReasoningEffort === 'object') {
    const overrides: Record<string, string> = {};
    for (const [model, value] of Object.entries(raw.aliasReasoningEffort as object)) {
      const effort = normalizeEffort(value, `aliasReasoningEffort.${model}`);
      if (effort) {
        overrides[model] = effort;
      }
    }
    if (Object.keys(overrides).length > 0) {
      config.aliasReasoningEffort = overrides;
    }
  }

  cache = { mtimeMs, config };
  return config;
}

/**
 * 決定某次 run 在「呼叫端沒指定 reasoning_effort」時該套用的預設值。
 *
 * 優先序（高 → 低）：
 *   1. 環境變數 AI_CLI_DEFAULT_REASONING_EFFORT
 *   2. config.json 的 aliasReasoningEffort[rawModel]
 *   3. config.json 的 defaultReasoningEffort
 *   4. 內建 ultra alias 預設（claude-ultra=max / codex-ultra=xhigh）
 *
 * 注意：這裡只回傳「想要的值」，是否真的套用由 caller 依 agent 能力決定。
 */
export function resolveConfiguredReasoningEffort(rawModel: string): string | undefined {
  const fromEnv = normalizeEffort(
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT,
    'AI_CLI_DEFAULT_REASONING_EFFORT'
  );
  if (fromEnv) return fromEnv;

  const config = loadUserConfig();
  const aliasOverride = config.aliasReasoningEffort?.[rawModel];
  if (aliasOverride) return aliasOverride;
  if (config.defaultReasoningEffort) return config.defaultReasoningEffort;

  return BUILTIN_ALIAS_REASONING[rawModel];
}

/** 給 models / doctor 工具回報目前生效的設定。 */
export function describeUserConfig() {
  const config = loadUserConfig();
  return {
    path: CONFIG_PATH,
    exists: existsSync(CONFIG_PATH),
    envOverride: normalizeEffort(
      process.env.AI_CLI_DEFAULT_REASONING_EFFORT,
      'AI_CLI_DEFAULT_REASONING_EFFORT'
    ),
    defaultReasoningEffort: config.defaultReasoningEffort,
    aliasReasoningEffort: config.aliasReasoningEffort,
    builtinAliasReasoningEffort: BUILTIN_ALIAS_REASONING,
  };
}
