/**
 * 把判定核心同步到 plugin 目錄，讓 plugin 自足。
 *
 * 為什麼需要：`dist/` 不進版控。plugin 從 marketplace 安裝時，Claude Code 取得的是
 * **版控裡的檔案**，所以 hook 若去 import `../../dist/core/verification.js`，在正式
 * 安裝的機器上一定找不到——而 hook 的設計是「找不到就放行」，於是整個第 2 層
 * 會永久靜默失效，而且不會有任何錯誤訊息。2026-09-08 codex 稽核指出，實測確認
 * `git ls-files dist` 為 0。
 *
 * 做法是單一來源（src/core/verification.ts）+ build 後同步 + 一致性斷言：
 * verify-verification.mjs 會比對這支產生的檔案與 dist 的內容，不一致就 FAIL，
 * 所以「改了 src 卻忘了同步」會被 npm test 擋下來，不會偷偷漂移。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(ROOT, 'dist', 'core', 'verification.js');
export const TARGET = join(ROOT, 'plugin', 'hooks', 'verification-core.mjs');

export const HEADER = `/**
 * 【產生檔，請勿手改】由 tools/sync-plugin-core.mjs 於 npm run build 後從
 * dist/core/verification.js 複製而來，來源是 src/core/verification.ts。
 *
 * 之所以要複製一份進版控：dist/ 不進版控，而 plugin 從 marketplace 安裝時拿到的
 * 只有版控裡的檔案。hook 必須自足，否則在正式安裝的機器上會因為找不到判定模組
 * 而永久靜默放行。
 *
 * 要改判定邏輯請改 src/core/verification.ts，然後 npm run build。
 * 兩邊不一致時 verify-verification.mjs 會 FAIL。
 */
`;

/** 回傳同步後的內容（不含檔頭），供測試比對。 */
export function bodyOf(text) {
  return text.startsWith('/**') ? text.slice(text.indexOf('*/') + 2).replace(/^\r?\n/, '') : text;
}

export function sync() {
  if (!existsSync(SOURCE)) {
    console.error(`[sync-plugin-core] 找不到 ${SOURCE}，請先 npm run build`);
    process.exitCode = 1;
    return false;
  }
  const compiled = readFileSync(SOURCE, 'utf8');
  writeFileSync(TARGET, HEADER + compiled);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sync-plugin-core.mjs')) {
  if (sync()) console.log('[sync-plugin-core] plugin/hooks/verification-core.mjs 已同步');
}
