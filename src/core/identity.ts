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
  /**
   * 讀不到時說明原因，正常時為 `null`——**欄位永遠在**。
   *
   * 這一點與 `describeConfiguredProviders`（`note: string | null`）、`updateNotice`
   * 與 `checks.loginState` 一致：欄位消失的話，呼叫端分不出「這一版沒有這個欄位」
   * 與「這一版有、只是這次沒問題」。呼叫端是另一個 AI，它讀不到原始碼的註解。
   */
  note: string | null;
}

const require = createRequire(import.meta.url);

/**
 * `git+https://github.com/x/y.git` → `https://github.com/x/y`。
 *
 * package.json 的 repository 是給 npm 用的 git URL，直接回傳的話呼叫端拿到
 * 的是一個貼進瀏覽器不會動的字串。
 *
 * **只處理 `http(s)://` 與 `git+http(s)://` 這兩種認得出來的形狀，其餘原樣回傳。**
 * npm 也接受 `github:owner/repo`、`owner/repo` 與 `git@github.com:owner/repo.git`
 * 這類寫法——對它們做半套正規化比不做更糟：把 scp 形式的 `.git` 剝掉之後，
 * 得到的字串既不能 clone 也不能貼進瀏覽器，而呼叫端是 AI，它會直接當網址用。
 */
export function normalizeRepositoryUrl(raw: unknown): string | null {
  const url = typeof raw === 'string' ? raw : (raw as { url?: unknown } | null | undefined)?.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  const stripped = url.replace(/^git\+/, '');
  if (!/^https?:\/\//.test(stripped)) return url;
  return stripped.replace(/\.git$/, '');
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
      note: null,
    };
  } catch (error) {
    // 規則 1：不丟錯。呼叫端看到 note 就知道是「讀不到」而不是「沒有這些欄位」。
    //
    // ⚠️ note **只回錯誤類別，不回原始 message**：ENOENT / EACCES 的訊息通常帶著
    // 絕對安裝路徑（在 Windows 上就是使用者名稱與目錄結構），而這個結構會原樣進
    // doctor / models 的工具回傳。詳細訊息寫 stderr，那裡不是對外通道。
    const code = (error as { code?: unknown } | null | undefined)?.code;
    const kind =
      typeof code === 'string' ? code : error instanceof Error ? error.name : 'UnknownError';
    console.error(
      `[identity] 讀不到 package.json：${error instanceof Error ? error.message : String(error)}`
    );
    return {
      name: null,
      version: null,
      repository: null,
      homepage: null,
      note: `讀不到 package.json（${kind}）`,
    };
  }
}

// 身分描述的是**本次已載入的這個 process**，所以第一次讀完就固定。
// 背景更新確實會改動磁碟上的 package.json，但執行中的 server 仍跑舊 dist、
// 下次啟動才生效（見 updater.ts），所以跟著磁碟變反而會說謊。
//
// 凍結是因為這個物件會原樣交給 doctor 與 models 共用——不凍的話，任何一個
// 呼叫端改到它，另一個就跟著被污染。
let cached: ServerIdentity | undefined;

/** 這個 server 的身分。永不丟錯、不查網路、回傳唯讀。 */
export function getServerIdentity(): ServerIdentity {
  if (!cached) cached = Object.freeze(readIdentity());
  return cached;
}
