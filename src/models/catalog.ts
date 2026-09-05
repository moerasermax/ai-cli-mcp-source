/**
 * Model 目錄與 alias 表。
 * 5.0.0 起只剩 claude / codex / antigravity / direct-api（kiro 與 forge 已移除）。
 *
 * 各 agent 的 model 清單其實也定義在各自的 agents/<name>.ts，
 * 這裡彙整出對外的 models payload 與描述字串。
 */

import { listAgents, getAgent, selectAgentForModel } from '../agents/registry.js';
import { resolveDirectApiModel } from '../agents/direct-api.js';
import { buildCatalogV2 } from './catalog-v2.js';
import type { AgentId } from '../agents/types.js';
import { acceptsConfiguredEffort } from '../core/reasoning.js';
import { consumeNotice } from '../core/updater.js';
import {
  describeUserConfig,
  loadUserConfigSnapshot,
  resolveConfiguredAliasModel,
  resolveConfiguredReasoningEffort,
  type ConfigSnapshot,
  type UserConfig,
} from '../core/user-config.js';

export interface ModelAliasDetail {
  name: string;
  resolvesTo: string;
  agent: AgentId;
  defaultReasoningEffort?: string;
}

/** alias 的實際生效狀態：可能被 config.json 的 aliasModel 重新指向。 */
export interface EffectiveModelAliasDetail extends ModelAliasDetail {
  /** 這個 alias 目前是走內建表還是使用者設定。 */
  source: 'builtin' | 'config';
  /** source 為 config 時，內建表原本指向的 model。 */
  builtinResolvesTo?: string;
}

/** alias → 實際 model。1:1 還原 dist。 */
export const MODEL_ALIASES: Record<string, string> = {
  'claude-ultra': 'opus',
  'codex-ultra': 'gpt-6-astra',
  'agy-ultra': 'Gemini 3.1 Pro (High)',
  'antigravity-ultra': 'Gemini 3.1 Pro (High)',
};

/**
 * 5.0.0 移除的 agent 所帶走的 model 名稱。
 *
 * 為什麼要留這份清單而不是直接讓它們變成「未知 model」：claude 的 matchesModel 是
 * catch-all 永遠回 true，不特別攔的話這些名稱會**靜默跑去 claude** —— 呼叫端以為在跑
 * Kiro，實際上拿到的是 Claude 的回答。這個 repo 已經為同類的靜默路由吃過虧，
 * 所以寧可多一份清單，也要讓錯誤明確。
 *
 * 注意：這裡只擋「裸名稱」。`forge-<model>` 這種 provider-prefixed 形式仍然有效，
 * 因為 forge 也可以是 providers.json 裡的 provider key，且那條路在
 * command-builder 的 resolveDirectApiModel() 就先被解析走了。
 */
export const REMOVED_MODELS: Record<string, string> = {
  kiro: 'Kiro',
  'kiro-default': 'Kiro',
  'kiro-ultra': 'Kiro',
  'kiro-deepseek-3.2': 'Kiro',
  'kiro-minimax-m2.5': 'Kiro',
  'kiro-minimax-m2.1': 'Kiro',
  'kiro-glm-5': 'Kiro',
  'kiro-qwen3-coder-next': 'Kiro',
  forge: 'Forge',
};

/** 這個 model 名稱是否屬於已移除的 agent。用 hasOwnProperty 避免打到 Object.prototype。 */
export function isRemovedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMOVED_MODELS, model);
}

/** 已移除 model 的統一錯誤訊息。 */
export function removedModelMessage(model: string): string {
  const agent = REMOVED_MODELS[model];
  return (
    `Model "${model}" was removed in 5.0.0 along with the ${agent} agent ` +
    `(Kiro: out of quota / not logged in; Forge: CLI never installed). ` +
    `Use claude, codex, or antigravity instead, or connect any third-party ` +
    `OpenAI-compatible API yourself via direct-api ("<provider>-<model>", ` +
    `configured in ~/.local/share/ai-cli/providers.json).`
  );
}

/** alias 詳細資訊的內建定義。實際生效值請用 getEffectiveAliasDetails()。 */
export const MODEL_ALIAS_DETAILS: ModelAliasDetail[] = [
  { name: 'claude-ultra', resolvesTo: 'opus', agent: 'claude', defaultReasoningEffort: 'max' },
  { name: 'codex-ultra', resolvesTo: 'gpt-6-astra', agent: 'codex', defaultReasoningEffort: 'max' },
  { name: 'agy-ultra', resolvesTo: 'Gemini 3.1 Pro (High)', agent: 'antigravity' },
  { name: 'antigravity-ultra', resolvesTo: 'Gemini 3.1 Pro (High)', agent: 'antigravity' },
];

/** direct-api 動態 model 後端提示。 */
export const DIRECT_API_DYNAMIC_BACKEND = {
  explicitPrefixes: {
    or: 'openrouter',
    ds: 'dashscope',
  },
  explicitPattern: '<provider>-<model>',
  providersConfig: '~/.local/share/ai-cli/providers.json',
  modelsAreDynamic: true,
} as const;

/**
 * alias → 實際 model。優先序：config.json 的 aliasModel → 內建 MODEL_ALIASES → 原樣回傳。
 *
 * 這個函式是在每次 run 組指令時才呼叫（見 core/command-builder.ts），
 * 而 loadUserConfig() 每次都重讀設定檔，所以改設定檔後不必重啟 MCP server。
 */
export function isBuiltinAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name);
}

export function resolveModelAlias(model: string, config?: UserConfig): string {
  const configured = resolveConfiguredAliasModel(model, config ?? loadUserConfigSnapshot().config);
  if (configured) return configured;
  // 必須用 hasOwnProperty：'constructor' / 'toString' 這類 prototype 上的 key
  // 用 MODEL_ALIASES[model] 取會拿到函式而不是 undefined，resolvedModel 就不是字串了。
  return isBuiltinAlias(model) ? MODEL_ALIASES[model] : model;
}

/**
 * 決定某個（已解析 alias 後的）model 由哪個 agent 負責。
 * 與 command-builder.resolveModelSelection 的路由順序一致：direct-api 的
 * provider prefix 先解析，其餘交給 registry 的 matchesModel 依序比對。
 */
export function resolveAgentIdForModel(resolvedModel: string): AgentId {
  try {
    if (resolveDirectApiModel(resolvedModel)) return 'direct-api';
  } catch {
    // resolveDirectApiModel 對「像 provider prefix 但格式錯」的輸入會丟錯；
    // 這裡只是要判斷歸屬，交給一般路由即可。
  }
  return selectAgentForModel(resolvedModel).id;
}

/**
 * 目前實際生效的 alias 清單。alias 被 config 重新指向時，agent 欄位會跟著重算 —
 * 不能沿用 MODEL_ALIAS_DETAILS 裡寫死的 agent，否則 codex-ultra 被改指到 opus 時
 * 會用錯的 agent 去判斷 reasoning 能力。
 */
export function getEffectiveAliasDetails(
  config: UserConfig = loadUserConfigSnapshot().config
): EffectiveModelAliasDetail[] {
  return MODEL_ALIAS_DETAILS.map((builtin) => {
    const override = resolveConfiguredAliasModel(builtin.name, config);
    const resolvesTo = override ?? builtin.resolvesTo;
    const detail: EffectiveModelAliasDetail = {
      ...builtin,
      resolvesTo,
      agent: resolveAgentIdForModel(resolvesTo),
      source: override ? 'config' : 'builtin',
    };
    if (override) {
      detail.builtinResolvesTo = builtin.resolvesTo;
    }
    return detail;
  });
}

/** 依固定顯示順序取得各 agent 的 model 清單。 */
/**
 * 對外的各 agent model 清單。
 *
 * ★ 2026-08-22：以前這裡只回**靜態**的 `agent.models`，於是 agy 的動態查詢修好之後，
 *   catalogV2 誠實地列出 11 個實查模型，而這裡（也就是 `run` 的候選名單與工具描述）
 *   還停在寫死的 4 個——查得到、跑得動、卻沒被列在使用者真正會看的地方。
 *
 *   現在改成「靜態清單 ∪ 實查到且可路由的」：
 *   - **只增不減**。靜態清單是策展過的（含 `agy` / `agy-default` 這種框架 alias，
 *     它們不是 vendor 的模型 id，查詢永遠不會回報它們），砍掉會弄丟有效用法。
 *   - 實查來的只收 `routable` 的。vendor 回報但本框架路由不到的名字（agy 代理的
 *     `claude-sonnet-4-6` 之類）**不進候選名單**——列出來就要叫得動。
 *     它們仍完整出現在 `catalogV2`，標著 `routable: false`。
 */
function modelsByAgent(): Record<AgentId, readonly string[]> {
  const discovered = new Map<AgentId, string[]>();
  for (const entry of buildCatalogV2().entries) {
    if (!entry.routable) continue;
    const list = discovered.get(entry.agent);
    if (list) list.push(entry.model);
    else discovered.set(entry.agent, [entry.model]);
  }

  const out = {} as Record<AgentId, readonly string[]>;
  for (const agent of listAgents()) {
    const known = new Set(agent.models);
    const extra = (discovered.get(agent.id) ?? []).filter((model) => !known.has(model));
    out[agent.id] = extra.length > 0 ? [...agent.models, ...extra] : agent.models;
  }
  return out;
}

/** run 工具描述用的「Supported models」一行字串。1:1 對齊 dist 順序。 */
export function getSupportedModelsDescription(): string {
  const byAgent = modelsByAgent();
  return [
    '"claude-ultra", "codex-ultra", "agy-ultra"',
    ...byAgent.claude.map((m) => `"${m}"`),
    ...byAgent.codex.map((m) => `"${m}"`),
    ...byAgent.antigravity.map((m) => `"${m}"`),
    ...byAgent['direct-api'].map((m) => `"${m}"`),
  ].join(', ');
}

/** model 參數的長描述。1:1 還原 dist。 */
export function getModelParameterDescription(): string {
  const byAgent = modelsByAgent();
  const all = [
    ...byAgent.claude,
    ...byAgent.codex,
    ...byAgent.antigravity,
    ...byAgent['direct-api'],
  ];
  return `The model to use. Aliases: "claude-ultra" (auto max effort), "codex-ultra" (auto max reasoning), "agy-ultra" (Antigravity CLI). Standard: ${all
    .map((m) => `"${m}"`)
    .join(
      ', '
    )}. "gpt-6-astra" (and therefore "codex-ultra") needs codex-cli 0.153 or newer; 0.151 is rejected by the API with "requires a newer version of Codex". direct-api accepts provider-prefixed models using "or-<model>" for OpenRouter, "ds-<model>" for DashScope, or "<provider>-<model>" for any provider key configured in ~/.local/share/ai-cli/providers.json — this is how you connect a third-party OpenAI-compatible API yourself. A name like "forge-<model>" is therefore read as provider "forge" plus a model, not as the removed Forge CLI. Antigravity (agy) accepts model selection: the name is normalized to an agy model id and passed as --model, while "agy" and "agy-default" pass nothing and fall back to the agy CLI's own default. agy carries the reasoning level in the model id itself (-high / -medium / -low), which is why reasoning_effort is not accepted for it. The Kiro and Forge agents were removed in 5.0.0 — their model names are now rejected with an explicit error rather than silently falling back to Claude.`;
}

/** 所有 agent 宣告的 model 名稱（不含 direct-api 的動態 provider-prefixed 名稱）。 */
export function listKnownModels(): string[] {
  return listAgents().flatMap((agent) => [...agent.models]);
}

/**
 * 判斷一個 model 名稱是否「真的被認得」。
 *
 * 之所以需要這個：claude agent 的 matchesModel 永遠回 true（registry 的 fallback），
 * 所以打錯字的 model 不會報錯，而是被靜默送去 claude。設定 alias 時必須主動擋掉。
 */
export function isKnownModelTarget(model: string): boolean {
  // alias 名稱不是 model。alias 解析只做一層，把 alias 當 target 會直接把該名稱
  // 原樣送進 CLI（例如 agy-ultra 會被當成 model 名稱送出去）。
  if (isBuiltinAlias(model)) return false;

  // 已移除的 agent 名稱不能當 alias target，否則會在 run 時才炸。
  if (isRemovedModel(model)) return false;

  // direct-api 的 provider prefix 必須真的解析得出來。只看 matchesModel 不夠：
  // 它是 startsWith('or-')/startsWith('ds-')，'or-' 這種空 model 也會過，
  // 但 run 的時候 resolveDirectApiModel 會丟錯 → 設定成功卻每次 run 都爆。
  const looksLikeDirectApi = listAgents().some(
    (agent) => agent.id === 'direct-api' && agent.matchesModel(model)
  );
  if (looksLikeDirectApi) {
    try {
      return resolveDirectApiModel(model) !== null;
    } catch {
      return false;
    }
  }
  try {
    if (resolveDirectApiModel(model)) return true;
  } catch {
    return false;
  }

  if (listKnownModels().includes(model)) return true;
  // 非 fallback agent 的 pattern 命中也算（例如任意 gpt-* 交給 codex）。
  return listAgents().some((agent) => agent.id !== 'claude' && agent.matchesModel(model));
}

/** models 工具的完整 payload。1:1 還原 dist。 */
export function getModelsPayload(snapshot: ConfigSnapshot = loadUserConfigSnapshot()) {
  const byAgent = modelsByAgent();
  // 整個 payload 共用同一份 snapshot：否則每個 alias 各讀一次設定檔，
  // 中途被改動就會回報出「不同 alias 來自不同版本設定」的畫面。
  // set_config 會把「剛寫入的那一份」直接傳進來，連寫完再讀一次都省掉。
  const { config } = snapshot;
  return {
    updateNotice: consumeNotice(),
    aliases: getEffectiveAliasDetails(config).map((alias) => {
      // 只回報「真的會被送進 CLI」的 effort，規則與 command-builder 送出時共用同一個
      // acceptsConfiguredEffort：agent 不支援 reasoning（agy / direct-api），或值不在該 agent
      // 的允許集合（codex-ultra 被重指到 opus 後，內建的 ultra 對 claude 不成立），都不回報，
      // 否則會回報一個指令裡根本沒有的值。後者是獨立稽核 @codex-gpt-6-astra 抓到的：
      // 舊寫法只看 supported、不看 allowed。
      const support = getAgent(alias.agent).reasoning;
      const { defaultReasoningEffort: _builtin, ...rest } = alias;
      if (!support.supported) return rest;
      const effective = resolveConfiguredReasoningEffort(alias.name, config);
      if (effective && !acceptsConfiguredEffort(support, effective)) return rest;
      return { ...rest, defaultReasoningEffort: effective };
    }),
    claude: byAgent.claude,
    codex: byAgent.codex,
    antigravity: byAgent.antigravity,
    'direct-api': byAgent['direct-api'],
    /*
      ★ v2 目錄：**每一筆都說得出自己的出處與時間**。

        上面那四個陣列是既有形狀、有現成消費者，所以不動。但它們沒有
        任何欄位能讓讀的人分辨「這是問過 vendor 的」還是「這是原始碼裡
        的靜態值」——2026-07-31 就因此發生過一次把過時硬編當成事實
        轉述的誤導（agy 的模型清單與 --model 支援度都早已改變）。

        新的消費端請一律讀 `catalogV2`。
    */
    catalogV2: buildCatalogV2(),
    dynamicModelBackends: {
      'direct-api': DIRECT_API_DYNAMIC_BACKEND,
    },
    userConfig: {
      ...describeUserConfig(snapshot),
      builtinAliasModel: MODEL_ALIASES,
    },
  };
}
