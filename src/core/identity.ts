/**
 * 這個 server 說得出自己是誰。
 *
 * 為什麼需要這個檔：MCP 的註冊內容只有一行 `node <path>/dist/server.js`，
 * 呼叫端（通常是另一個 AI）從工具名 `ai-cli` 認得出「有這組工具」，卻認不出
 * 它對應哪個 repo、哪個 npm 套件、哪一版。2026-09-09 改名之後
 * （repo → tkflyc-ai-cli、npm scope → @tkflyc）這變成實際問題：別的 session
 * 去查外部紀錄，拿到的是改名前的答案——不是查不到，是**被積極告知舊的**。
 *
 * 所以身分要由工具自己講，而不是靠外部紀錄跟上。這與 catalogV2「每一筆都
 * 說得出自己的出處」是同一條原則。
 *
 * 三條規則，與 describeConfiguredProviders 同源：
 *   1. **永不丟錯** —— 這個結構會原樣進 doctor / models 的回傳。
 *   2. **不查網路** —— 只讀自己的 package.json。
 *   3. **不硬編名稱** —— 名字寫死在原始碼裡，下次改名就會再說一次謊，
 *      而那正是本檔要解決的問題。讀不到就回 null 加 note。
 */

import { createRequire } from 'node:module';

export interface ServerIdentity {
  /** npm 套件名。讀不到 package.json 時為 null，不猜。 */
  name: string | null;
  version: string | null;
  /** 正規化過的可瀏覽網址；沒有 repository 欄位時為 null。 */
  repository: string | null;
  homepage: string | null;
  /** 只有在讀不到時才出現：「讀不到」與「沒設定」對呼叫端是兩件事。 */
  note?: string;
}

const require = createRequire(import.meta.url);

/**
 * `git+https://github.com/x/y.git` → `https://github.com/x/y`。
 *
 * package.json 的 repository 是給 npm 用的 git URL，直接回傳的話呼叫端拿到
 * 的是一個貼進瀏覽器不會動的字串。認不出的形狀原樣回傳，不要猜。
 */
export function normalizeRepositoryUrl(raw: unknown): string | null {
  const url = typeof raw === 'string' ? raw : (raw as { url?: unknown } | null | undefined)?.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

function readIdentity(): ServerIdentity {
  try {
    const pkg = require('../../package.json') as {
      name?: unknown;
      version?: unknown;
      repository?: unknown;
      homepage?: unknown;
    };
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      repository: normalizeRepositoryUrl(pkg.repository),
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
    };
  } catch (error) {
    // 規則 1：不丟錯。呼叫端看到 note 就知道是「讀不到」而不是「沒有這些欄位」。
    return {
      name: null,
      version: null,
      repository: null,
      homepage: null,
      note: `讀不到 package.json：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// 套件檔在行程存活期間不會改變（更新走的是換行程，見 updater.ts），所以讀一次就好。
let cached: ServerIdentity | undefined;

/** 這個 server 的身分。永不丟錯、不查網路。 */
export function getServerIdentity(): ServerIdentity {
  if (!cached) cached = readIdentity();
  return cached;
}
