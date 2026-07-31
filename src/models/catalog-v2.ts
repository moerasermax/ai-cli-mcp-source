/**
 * 模型目錄 v2 — **每一筆都說得出自己的出處與時間**。
 *
 * ── 為什麼要有這一層 ──────────────────────────────────────────
 * 2026-07-31 發生過一次具體的誤導：有人照 `agents/antigravity.ts` 的
 * 註解斷定「agy 不支援 --model」，並把它當成事實轉述給使用者。
 * 實測 agy v1.1.9 早就支援了，而且模型清單從 4 個變成 11 個。
 *
 * 根因**不是註解沒更新**——那只是症狀。根因是：
 * **硬編的清單沒有標明自己是硬編的**，讀的人（人或 AI）就沒有理由懷疑它。
 *
 * 所以這一層不試圖「保證清單永遠正確」（做不到，vendor 隨時會改），
 * 而是保證**清單永遠說得出自己是怎麼來的**：
 *
 *   source: 'vendor-cli'        這一輪真的問過 CLI，verifiedAt 是問到的時間
 *   source: 'builtin-fallback'  原始碼裡的靜態值，**未經確認**
 *
 * 消費端可以自己決定要不要信 fallback，但**不會再誤以為那是事實**。
 *
 * ── 為什麼是新檔而不是改 catalog.ts ──────────────────────────
 * `models --json` 既有的頂層形狀（各 agent 一個字串陣列 + aliases）
 * 有現成的消費者。直接改會破壞它們。v2 以**新欄位**加上去，舊欄位不動。
 */

import { listAgents } from '../agents/registry.js';
import type { AgentDefinition, AgentId, BillingRoute, ModelListSource } from '../agents/types.js';
import { inspectCliBinary } from '../core/binary-resolver.js';

export interface CatalogEntry {
  /** 穩定識別：`{agent}/{model}`。消費端該存這個，不是顯示名。 */
  id: string;
  agent: AgentId;
  model: string;
  /** `{Vendor}_{Model}` —— 給人看的，不要拿來當鍵。 */
  displayName: string;
  billingRoute: BillingRoute;
  source: ModelListSource;
  /** ISO8601。`builtin-fallback` 也給，代表「這一輪讀到這份靜態值的時間」。 */
  verifiedAt: string;
}

export interface CatalogV2 {
  entries: CatalogEntry[];
  /**
   * 各 agent 這一輪的查詢結果。
   * `binaryFound: false` 時 source 必然是 builtin-fallback——
   * 這兩件事要一起看，否則「沒問到」會被誤讀成「問到了但只有這些」。
   */
  agents: Array<{
    agent: AgentId;
    binaryFound: boolean;
    source: ModelListSource;
    /** 有 discoverModels 卻回 null 時的說明。沒有查詢能力就是 null。 */
    discoveryNote: string | null;
  }>;
  generatedAt: string;
}

/** 顯示名的 vendor 段。**只影響顯示**，不參與任何比對。 */
const VENDOR_LABEL: Record<AgentId, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  antigravity: 'Antigravity',
  'direct-api': 'DirectAPI',
};

/**
 * 查詢結果的行程內快取。
 *
 * `models --json` 可能被頻繁呼叫（MCP 工具描述會用到），而每次都
 * spawn 一輪 vendor CLI 是不必要的成本。TTL 內重用，並**照實回報
 * 當初問到的 verifiedAt**——不是回報「現在」，那會讓一份五分鐘前的
 * 答案看起來像剛剛確認過的。
 */
const CACHE_TTL_MS = 60_000;
interface CacheRow {
  models: readonly string[];
  source: ModelListSource;
  verifiedAt: string;
  binaryFound: boolean;
  discoveryNote: string | null;
  cachedAtMs: number;
}
const cache = new Map<AgentId, CacheRow>();

/** 測試用：清掉快取，讓下一次呼叫真的去問。 */
export function clearCatalogCache(): void {
  cache.clear();
}

function resolveFor(agent: AgentDefinition): { path: string | null; found: boolean } {
  // direct-api 沒有本機二進位檔——那不是「找不到」，是本來就沒有。
  if (!agent.binary) return { path: null, found: false };
  try {
    const status = inspectCliBinary(agent.binary);
    return { path: status.resolvedPath, found: status.available && status.resolvedPath !== null };
  } catch {
    return { path: null, found: false };
  }
}

function loadAgent(agent: AgentDefinition, nowMs: number): CacheRow {
  const cached = cache.get(agent.id);
  if (cached && nowMs - cached.cachedAtMs < CACHE_TTL_MS) return cached;

  const fallback = (discoveryNote: string | null, binaryFound: boolean): CacheRow => ({
    models: agent.models,
    source: 'builtin-fallback',
    verifiedAt: new Date(nowMs).toISOString(),
    binaryFound,
    discoveryNote,
    cachedAtMs: nowMs,
  });

  if (typeof agent.discoverModels !== 'function') {
    // 沒有查詢能力不是失敗，但也不能假裝問過。
    return fallback(null, resolveFor(agent).found);
  }

  const { path, found } = resolveFor(agent);
  if (!found || path === null) {
    return fallback('找不到這個 agent 的 CLI 二進位檔，無法向它查詢模型清單。', false);
  }

  const discovered = agent.discoverModels(path);
  if (discovered === null || discovered.length === 0) {
    return fallback('已找到 CLI 但查詢模型清單失敗（逾時／非零退出／空輸出）。', true);
  }

  const row: CacheRow = {
    models: discovered,
    source: 'vendor-cli',
    verifiedAt: new Date(nowMs).toISOString(),
    binaryFound: true,
    discoveryNote: null,
    cachedAtMs: nowMs,
  };
  cache.set(agent.id, row);
  return row;
}

export function buildCatalogV2(): CatalogV2 {
  const nowMs = Date.now();
  const entries: CatalogEntry[] = [];
  const agents: CatalogV2['agents'] = [];

  for (const agent of listAgents()) {
    const row = loadAgent(agent, nowMs);
    cache.set(agent.id, row);
    agents.push({
      agent: agent.id,
      binaryFound: row.binaryFound,
      source: row.source,
      discoveryNote: row.discoveryNote,
    });
    for (const model of row.models) {
      entries.push({
        id: `${agent.id}/${model}`,
        agent: agent.id,
        model,
        displayName: `${VENDOR_LABEL[agent.id]}_${model}`,
        billingRoute: agent.billingRoute ?? 'subscription-cli',
        source: row.source,
        verifiedAt: row.verifiedAt,
      });
    }
  }

  return { entries, agents, generatedAt: new Date(nowMs).toISOString() };
}
