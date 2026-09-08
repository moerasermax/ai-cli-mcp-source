#!/usr/bin/env node
/**
 * 檢查「程式碼修改驗證閘門」是否已從這台機器完全移除。
 *
 * 為什麼需要這支：自動更新只帶得動 repo 裡的程式碼，帶不動每台機器
 * `~/.claude/plugins/` 底下的安裝——那是 `/plugin install` 當時複製過去的副本，
 * `git pull` 永遠碰不到它。所以其他機器拉到新版之後，plugin 仍然會繼續跑舊副本
 * 並繼續擋人，必須各自手動移除一次。
 *
 * 這支**只檢查與回報，不改任何設定檔**。要不要動 Claude Code 的設定是使用者的事，
 * 派工工具靜默改寫使用者設定是壞設計。它會把該跑的指令原樣印出來讓你複製。
 *
 * 用法：node tools/check-gate-removed.mjs
 * 結束碼：0 = 已完全移除；1 = 還有殘留（詳見輸出）
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const H = homedir();
const PLUGIN = 'ai-cli-verification-gate';
const MARKETPLACE = 'ai-cli-mcp';
const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
};

const findings = [];
function check(clean, label, remedy) {
  console.log(`  ${clean ? '✅ 乾淨  ' : '❌ 有殘留'}  ${label}`);
  if (!clean) findings.push({ label, remedy });
}

console.log('\n【這台機器的 Claude Code】');

/*
  只比對 key，不要對整份 JSON 做字串包含比對。
  settings.json 裡可能有其他跟 ai-cli 有關但與閘門無關的東西（例如 MCP 權限、
  你自己的 hook），寬鬆比對會誤報成「還有殘留」。
*/
const installed = readJson(join(H, '.claude/plugins/installed_plugins.json'));
const installedKeys = Object.keys(installed?.plugins ?? installed ?? {});
check(
  !installedKeys.some((k) => k.startsWith(PLUGIN)),
  'installed_plugins.json —— 這份決定 hook 到底跑不跑',
  `/plugin uninstall ${PLUGIN}@${MARKETPLACE}`
);

const known = readJson(join(H, '.claude/plugins/known_marketplaces.json'));
check(
  !Object.keys(known?.marketplaces ?? known ?? {}).includes(MARKETPLACE),
  'known_marketplaces.json',
  `/plugin marketplace remove ${MARKETPLACE}`
);

const settings = readJson(join(H, '.claude/settings.json')) ?? {};
check(
  !Object.keys(settings.enabledPlugins ?? {}).some((k) => k.startsWith(PLUGIN)),
  'settings.json 的 enabledPlugins',
  `/plugin uninstall ${PLUGIN}@${MARKETPLACE}`
);
check(
  !Object.keys(settings.extraKnownMarketplaces ?? {}).includes(MARKETPLACE),
  'settings.json 的 extraKnownMarketplaces',
  `/plugin marketplace remove ${MARKETPLACE}`
);

/*
  `/plugin marketplace remove` 只清註冊，**不一定清得掉 cache 的副本**（2026-09-08 實測）。
  孤兒 cache 不會被載入（載入清單看的是 installed_plugins.json），但留著沒有意義。
*/
const marketplaceDir = join(H, '.claude/plugins/marketplaces', MARKETPLACE);
const cacheDir = join(H, '.claude/plugins/cache', MARKETPLACE);
check(!existsSync(marketplaceDir), `磁碟：${marketplaceDir}`, `Remove-Item -Recurse -Force "${marketplaceDir}"`);
check(!existsSync(cacheDir), `磁碟：${cacheDir}`, `Remove-Item -Recurse -Force "${cacheDir}"`);

console.log('\n【這份 ai-cli 安裝】');
for (const [label, rel] of [
  ['plugin/', 'plugin'],
  ['.claude-plugin/', '.claude-plugin'],
  ['src/core/verification.ts', 'src/core/verification.ts'],
  ['dist/core/verification.js（建置產物）', 'dist/core/verification.js'],
]) {
  check(!existsSync(join(REPO, rel)), label, 'git pull --ff-only && npm install');
}

const stateDir = process.env.AI_CLI_STATE_DIR || join(H, '.local/state/ai-cli');
const marker = join(stateDir, 'install.json');
check(!existsSync(marker), `install marker：${marker}`, `Remove-Item -Force "${marker}"`);

/*
  記錄檔是**資料**，不是程式。它裝的是這台機器過去累積的品質基線，
  刪掉就再也回不來，所以這裡只提示、不判定為殘留——要不要留是使用者的事。
*/
const log = join(stateDir, 'verification-gate.jsonl');
if (existsSync(log)) {
  const rows = readFileSync(log, 'utf-8').split('\n').filter(Boolean).length;
  console.log(`\n【順帶一提】閘門過去的紀錄還在（${rows} 筆）：`);
  console.log(`  ${log}`);
  console.log('  這是資料不是程式，不算殘留。要留著做事後分析就別刪。');
}

if (findings.length === 0) {
  console.log('\n驗證閘門已完全移除 ✅');
  process.exit(0);
}

console.log(`\n還有 ${findings.length} 處殘留，依序處理：\n`);
const seen = new Set();
for (const { label, remedy } of findings) {
  if (seen.has(remedy)) continue;
  seen.add(remedy);
  console.log(`  # ${label}`);
  console.log(`  ${remedy}\n`);
}
console.log('（`/plugin ...` 要在 Claude Code 裡輸入，其餘在 PowerShell 跑。）');
process.exit(1);
