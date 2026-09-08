/**
 * 隨附 Claude Code plugin 的安裝偵測。
 *
 * 為什麼需要這一層：自動更新只散布**程式**，不散布**啟用狀態**。
 * plugin 的檔案會跟著 `git pull` 出現在每台機器上，但 Claude Code 要不要載入它，
 * 記在各機器自己的 `~/.claude/settings.json`。ai-cli 不去改那個檔——一個派工工具
 * 靜默改寫使用者的 Claude Code 設定是壞設計（2026-09-08 codex 稽核意見）。
 *
 * 所以這裡只做一件事：**發現「檔案在、但這台機器沒啟用」並說出來**。
 * 要不要裝仍然是使用者按下去的，我們只負責讓他知道有這個東西。
 *
 * 吵不吵的問題比照 2026-09-05 的更新提示：doctor 主動查一律回報（查了才看到，不吵），
 * run / models 的被動提示**只印一次**，記在 state 裡；使用者之後真的啟用了就清掉，
 * 這樣萬一哪天又被停用，還會再提醒一次。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** plugin 名稱與 marketplace 名稱，必須與 plugin.json / marketplace.json 一致。 */
export const PLUGIN_NAME = 'ai-cli-verification-gate';
export const MARKETPLACE_NAME = 'ai-cli-mcp';
export const PLUGIN_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const REPO_SLUG = 'moerasermax/ai-cli-mcp-source';

export interface PluginStatus {
  /** plugin 檔案是否隨這份安裝一起存在（自動更新會帶下來）。 */
  bundled: boolean;
  /** 這台機器的 Claude Code 是否已啟用。 */
  enabled: boolean;
  /** marketplace 是否已加入。 */
  marketplaceAdded: boolean;
  version: string | null;
  /** 讀不到 settings.json 時說明原因；讀得到為 null。 */
  reason: string | null;
  /** 給人看的一段話，沒事為 null。 */
  notice: string | null;
}

function stateDir(): string {
  return process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
}

function settingsPath(): string {
  return (
    process.env.AI_CLI_CLAUDE_SETTINGS_PATH ||
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
  );
}

/** 這份安裝的 repo 根：dist/core/plugin-status.js → 上溯兩層。 */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const noticeFlagPath = () => join(stateDir(), 'plugin-notice.json');

export function getPluginStatus(): PluginStatus {
  const manifestPath = join(repoRoot(), 'plugin', '.claude-plugin', 'plugin.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const bundled = manifest !== null;
  const version = typeof manifest?.version === 'string' ? manifest.version : null;

  const settingsFile = settingsPath();
  let reason: string | null = null;
  let enabled = false;
  let marketplaceAdded = false;

  if (!existsSync(settingsFile)) {
    reason = `找不到 Claude Code 設定（${settingsFile}）`;
  } else {
    const settings = readJson(settingsFile);
    if (settings === null) {
      reason = `Claude Code 設定無法解析（${settingsFile}）`;
    } else {
      enabled = settings?.enabledPlugins?.[PLUGIN_KEY] === true;
      const marketplaces = settings?.extraKnownMarketplaces ?? {};
      marketplaceAdded =
        Object.prototype.hasOwnProperty.call(marketplaces, MARKETPLACE_NAME) ||
        Object.values(marketplaces).some(
          (entry: any) => entry?.source?.repo === REPO_SLUG
        );
    }
  }

  let notice: string | null = null;
  if (bundled && !enabled && reason === null) {
    notice =
      `這台機器尚未啟用驗證閘門 plugin（${PLUGIN_KEY}）。` +
      `自動更新只會帶下 plugin 的程式碼，不會替你啟用——啟用狀態記在各機器自己的 Claude Code 設定裡。\n` +
      (marketplaceAdded
        ? `啟用：/plugin install ${PLUGIN_KEY}`
        : `啟用：/plugin marketplace add ${REPO_SLUG} 然後 /plugin install ${PLUGIN_KEY}`) +
      `\n作用：改了程式碼卻沒跑驗證就結束回應時擋一次。不想要可以不裝，這則提示每 3 天最多出現一次。`;
  }

  return { bundled, enabled, marketplaceAdded, version, reason, notice };
}

/** 提醒間隔，預設 3 天（使用者 2026-09-08 裁定）。測試用環境變數縮短。 */
const DEFAULT_NOTICE_INTERVAL_SEC = 3 * 24 * 60 * 60;

function noticeIntervalMs(): number {
  const raw = Number(process.env.AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC);
  const seconds = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NOTICE_INTERVAL_SEC;
  return seconds * 1000;
}

/**
 * 被動管道（run / models）用的提示：**每 3 天最多一次**。
 *
 * 「只提醒一次」不夠——新機器上第一次跳出來時使用者多半在忙別的，錯過就永遠
 * 不會再看到，等於沒提醒。反過來每次 run 都喊又太吵（2026-09-05 已經在更新提示
 * 上吃過這個虧）。所以取中間：隔一段時間再提一次，直到真的啟用為止。
 *
 * 已啟用時清掉旗標，之後若又被停用，下一次就會重新開始提醒。
 */
export function consumePluginNotice(now = Date.now()): string | null {
  let status: PluginStatus;
  try {
    status = getPluginStatus();
  } catch {
    return null;
  }
  const flag = noticeFlagPath();
  if (status.enabled || status.notice === null) {
    try {
      rmSync(flag, { force: true });
    } catch {
      /* 清不掉不影響 */
    }
    return null;
  }
  try {
    const previous = existsSync(flag) ? readJson(flag) : null;
    const last = previous?.notifiedAt ? Date.parse(previous.notifiedAt) : NaN;
    // 壞掉或不存在的旗標當成「從沒提醒過」，寧可多提一次也不要永遠沉默。
    if (Number.isFinite(last) && now - last < noticeIntervalMs()) return null;
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(
      flag,
      JSON.stringify({ notifiedAt: new Date(now).toISOString(), plugin: PLUGIN_KEY })
    );
  } catch {
    // 寫不進去就別提示，否則每次 run 都會再喊一次
    return null;
  }
  return status.notice;
}
