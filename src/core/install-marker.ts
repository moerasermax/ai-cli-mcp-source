/**
 * 記下「這份 ai-cli 裝在哪裡」，讓隨附的 plugin 找得到最新的判定核心。
 *
 * 為什麼需要：Claude Code 安裝 plugin 是把 source 目錄**複製**到
 * `~/.claude/plugins/cache/`，之後 `git pull` 再怎麼前進，cache 裡那份都不會動。
 * 2026-09-08 實測踩到三次：閘門的誤判修好、push 了，使用者仍被舊判定擋，
 * 而且要重裝才會生效——重裝完我又改了兩次，他根本追不上。
 *
 * 所以 hook 改成**優先讀這裡指到的安裝**（跟著自動更新前進），
 * 讀不到才退回 plugin 自帶的那份。兩層的關係是：
 *
 *   有裝 ai-cli 的機器 → 跟著 ai-cli 更新，不必重裝 plugin
 *   沒裝 ai-cli 的機器 → 用 plugin 自帶的，仍然能運作
 *
 * 這個檔只放路徑，不放任何會影響判定的資料——它壞掉的最壞後果是退回自帶版本。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function stateDir(): string {
  return process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
}

const markerPath = () => join(stateDir(), 'install.json');

/** 這份安裝的 repo 根：dist/core/install-marker.js → 上溯兩層。 */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * 啟動時寫一次。寫失敗一律靜默——這只是給 plugin 的便利指引，
 * 沒有它 plugin 仍會用自帶的判定核心。
 */
export function writeInstallMarker(): void {
  try {
    const root = repoRoot();
    // 只在真的看得到判定核心時才寫，避免指到一個沒 build 過的目錄。
    if (!existsSync(join(root, 'dist', 'core', 'verification.js'))) return;
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ repoRoot: root, at: new Date().toISOString() });
    const current = existsSync(markerPath()) ? readFileSync(markerPath(), 'utf8') : '';
    // 內容沒變就不重寫，免得每次啟動都動檔案。
    if (current && JSON.parse(current)?.repoRoot === root) return;
    writeFileSync(markerPath(), payload);
  } catch {
    /* 寫不進去不影響任何功能 */
  }
}

/** 讀回安裝位置；讀不到或指向不存在的路徑一律回 null。 */
export function readInstallMarker(): string | null {
  try {
    const root = JSON.parse(readFileSync(markerPath(), 'utf8'))?.repoRoot;
    if (typeof root !== 'string' || !root) return null;
    return existsSync(join(root, 'dist', 'core', 'verification.js')) ? root : null;
  } catch {
    return null;
  }
}
