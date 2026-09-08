> English version: [README.md](README.md)

# ai-cli-mcp（自有可控版）

把 Claude / Codex / Antigravity(agy) 等本機 AI CLI，
以及**任何第三方 OpenAI-compatible API**（透過 direct-api，自己接）包成 MCP 工具，支援背景 job。這是**從原始碼自行維護**的版本，採用 registry-based
架構，新增 AI agent 只需新增一個檔案。

## 快速開始（clone 下來直接用）

```bash
git clone <repo-url> ai-cli-mcp-source
cd ai-cli-mcp-source
npm install                                          # 會自動觸發 build，產生 dist/
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```

`dist/` 不進版控，所以一定要編譯過才能用。`npm install` 會經由 `prepare` script
自動跑 `npm run build`，正常情況下不需要另外手動 build。
需要 Node `^20.19.0 || >=22.12.0`。細節與 PowerShell 版指令見下方「掛到 Claude Code」。

## 自動更新

三個 MCP 入口都在 transport 連線後正常服務，**3 秒後背景檢查 → 子程序背景套用 → 下次啟動生效**。
預設每小時檢查一次 `origin`；其他機器 push 新 commit 後，這台機器會在下一輪檢查發現。
更新不阻塞 MCP 啟動，也不自動終止目前的 server 或 agent job。

成功後 stderr 與 MCP `notifications/message`（warning）會提示：

```text
ai-cli 已更新至最新版（1234567 → abcdef0，2 個 commit），請重新啟動 MCP（Claude Code：/mcp 重連）。更新內容請至 https://github.com/moerasermax/ai-cli-mcp-source/blob/master/CHANGELOG.md 查看
abcdef0 fix: 最新修正標題
7654321 feat: 另一個改動標題
```

`doctor.update` 包含 `policy / checkedAt / local / remote / behind / available / lastApplied / notice`；
MCP `run` 啟動回傳與 `models` payload 另有 `updateNotice`（沒有提示為 `null`）。
讀取不會清除提示；新版啟動時，若 `lastApplied.to` 等於本次啟動的 HEAD，才清除 `notice`，
並在 stderr 印 `ai-cli 已是最新版 <sha7>`。MCP logging 由 server 宣告能力，通知遵守 client 的 `logging/setLevel`。

| `AI_CLI_AUTO_UPDATE` | 行為 |
|---|---|
| `on`（預設） | 背景檢查，發現新版後自動套用 |
| `check` | 只檢查並提示有新版，不套用 |
| `off` | 更新器完全不碰網路，仍可讀取既有狀態與提示 |

可在 MCP 的 `env` 中設定 policy、`AI_CLI_UPDATE_CHECK_INTERVAL_SEC`（預設 `3600`）與
`AI_CLI_UPDATE_BRANCH`。分支優先序為環境變數 → 目前分支 upstream 的分支名稱 → `master`，
實際 fetch/pull 的 remote 都是 `origin`。

狀態目錄為 `AI_CLI_STATE_DIR` 或預設 `~/.local/state/ai-cli`：

- `update.json`：`{ checkedAt, branch, local, remote, behind, available, lastApplied, notice }`。
  `lastApplied` 為 `null` 或 `{ at, from, to, ok, commits: [{ sha, subject }], message }`。
  時間用 ISO 8601，SHA 保存完整值；寫入採同目錄 tmp + rename，壞檔當空。
- `update.lock`：pid、時間與鎖識別碼。避免多個 server 同時套用；pid 不存在或超過 30 分鐘可回收。

以下情況不會自動套用：安裝不是含 `.git` 與 `package.json` 的 clone、追蹤檔有未 commit 改動、
目前分支不符、HEAD 不是遠端祖先（不能 fast-forward），或另一個更新程序持鎖。
未追蹤檔不影響髒樹判定，git 自身仍會拒絕覆蓋衝突檔案。
更新採 `pull --ff-only`；套件檔變動時執行 `npm install --no-audit --no-fund`（prepare 建置），
其他變動只執行 `npm run build`，最後以 `node dist/bin/ai-cli.js doctor` exit 0 做煙霧測試。
失敗會 reset 回原 HEAD 並重新 build；回滾失敗會明確回報，詳細指令結果在手動更新的 JSON `log`。
Windows 若其他 server 鎖住 `node-pty` 原生模組而出現 EPERM／EBUSY，會回滾並提示
「其他 ai-cli server 仍在執行，鎖住原生模組；關閉後再更新」，後續檢查會重試。
回滾只恢復原始碼與建置，不還原 `node_modules` 的完整安裝快照。

手動操作（尚未加入 PATH 時，以 `node dist/bin/ai-cli.js` 代替 `ai-cli`）：

```bash
ai-cli update --check          # 強制檢查，略過節流，不套用
ai-cli update                 # 強制檢查並套用；仍遵守 on/check/off
ai-cli update --json           # 結構化結果與指令 log
ai-cli doctor                 # 本機診斷與已保存的 update 區塊，不連更新網路
```

`check`／`off` 模式要手動套用時，先將 `AI_CLI_AUTO_UPDATE` 改為 `on`。
更新內容網址優先取 `package.json.homepage`，否則由 GitHub origin 推導該分支的 `CHANGELOG.md`。

**安全提醒：這是 public repo，協作者都有 push 權限。push 到 master 等於部署到所有啟用自動更新的機器，
push 前必須確認 `npm test` 全綠。**

## 架構

```
src/
├─ server.ts              # 預設進入點（啟動 MCP server）
├─ agents/                # ★ 每個 AI 一個檔，新增 AI 就加一個檔
│   ├─ types.ts               # AgentDefinition 介面（可擴充的核心契約）
│   ├─ registry.ts            # 中央註冊表（新增 agent 在此 import + 列入陣列）
│   ├─ claude.ts / codex.ts / antigravity.ts / direct-api.ts
├─ core/                  # 框架本體，新增 agent 時「不用動」
│   ├─ command-builder.ts     # model routing + 指令組裝協調
│   ├─ process-service.ts     # 記憶體版 job 管理（MCP 用）
│   ├─ file-process-service.ts# 檔案版 job 管理（ai-cli CLI 的 detached 用）
│   ├─ pty-runner.ts          # ConPTY（agy 等需要真實 TTY 的 CLI）
│   ├─ binary-resolver.ts     # CLI 二進位解析
│   ├─ user-config.ts        # ~/.local/share/ai-cli/config.json 讀寫（依內容快取）
│   ├─ updater.ts            # 背景檢查／子程序更新、鎖、回滾與重啟提示
│   ├─ circuit-breaker.ts    # AI 啟動熔斷器
│   ├─ peek.ts / peek-extractor.ts / process-result.ts / reasoning.ts / ansi.ts / debug.ts
│   └─ doctor.ts              # doctor + 解析所有 CLI 路徑
├─ models/
│   ├─ catalog.ts         # model 清單 / alias / 同步 models payload
│   └─ catalog-v2.ts      # 出處 / 時間 / 非同步查詢與磁碟快取
├─ plugins/
│   ├─ usage.ts           # 查額度外掛橋接（路徑由環境變數設定）
│   └─ usage-service.ts   # query_usage 工具的實作與快取
├─ app/
│   ├─ mcp.ts             # MCP server（11 個工具）
│   └─ cli.ts             # ai-cli 指令列
└─ bin/
    ├─ ai-cli-mcp.ts      # MCP server 入口
    └─ ai-cli.ts          # CLI 入口
```

## 開發

```bash
npm install        # 含 prepare → 自動 build 一次
npm run build      # tsc → dist/（改完 src/ 後手動重編）
npm run dev        # tsx 直跑 src/server.ts（改完即生效，不用 build）
npm run typecheck  # 只型別檢查
```

## 新增一個 AI agent

1. 複製 `src/agents/codex.ts` 成 `src/agents/<name>.ts`，實作 `AgentDefinition`：
   - `id` / `models` / `matchesModel` / `binary` / `reasoning` / `buildCommand` / `parseOutput`
   - 需要真實 TTY → 設 `win32SpawnMode: 'pty'`（參考 `antigravity.ts`）
   - 是真實 .exe（非 npm shim）→ 設 `win32DirectExec: true`
2. 在 `src/agents/registry.ts` import 並加進 `AGENTS` 陣列（claude 永遠最後，它是 fallback）。
3. 在 `src/agents/types.ts` 的 `AgentId` 加上新 id；若 agent 需要 CLI binary，更新
   `core/doctor.ts` 的 `CliPaths` 回傳欄位。
4. `npm run build`。

## 環境變數

| 變數 | 用途 |
|------|------|
| `MCP_CLAUDE_DEBUG=true` | 開啟 debug 日誌到 stderr |
| `AI_CLI_STATE_DIR` | CLI detached job 與更新狀態目錄（預設 `~/.local/state/ai-cli`） |
| `AI_CLI_CONFIG_DIR` | 使用者設定目錄（預設 `~/.local/share/ai-cli`）；測試以此隔離 config.json |
| `AI_CLI_AUTO_UPDATE` | `on`（預設）／`check`／`off`，見「自動更新」 |
| `AI_CLI_UPDATE_CHECK_INTERVAL_SEC` | 更新檢查間隔秒數，預設 `3600`；無效值使用預設 |
| `AI_CLI_UPDATE_BRANCH` | 覆寫更新分支；未設時依 upstream 或 master |
| `AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC` | 未啟用驗證閘門 plugin 時的提醒間隔秒數，預設 `259200`（3 天）；`0` 表示每次都提醒 |
| `AI_CLI_CLAUDE_SETTINGS_PATH` | 覆寫 Claude Code `settings.json` 路徑（偵測 plugin 是否啟用用，測試以此隔離） |
| `AI_CLI_USAGE_PLUGIN_BIN` | `ai-cli usage` 外掛的 .mjs 絕對路徑 |
| `CLAUDE_CLI_NAME` / `CODEX_CLI_NAME` / `AGY_CLI_NAME` | 覆寫各 CLI 的指令名稱或絕對路徑 |
| `AI_CLI_DISCOVER_TIMEOUT_MS` | 模型查詢逾時毫秒，預設 `15000`；測試可縮短，非正整數或超出計時器範圍則用預設值 |
| `AI_CLI_CATALOG_CACHE_PATH` | 模型磁碟快取路徑，預設 `~/.local/share/ai-cli/catalog-cache.json`；測試一律指向暫存目錄 |
| `AI_CLI_PROVIDERS_PATH` | direct-api providers.json 路徑（預設 `~/.local/share/ai-cli/providers.json`） |
| `AI_CLI_BREAKER_DISABLED=true` | 停用 AI 啟動熔斷器（預設啟用） |
| `AI_CLI_BREAKER_MODE` | `block`（預設，觸發即擋下並回報）或 `warn`（只警告不擋） |
| `AI_CLI_BREAKER_WINDOW_SEC` | 熔斷器滑動視窗秒數（預設 `60`） |
| `AI_CLI_BREAKER_MAX_STARTS` | 視窗內最大啟動次數，超過視為爆量（預設 `30`） |
| `AI_CLI_BREAKER_DUP_LIMIT` | 視窗內「同一 agent + 同一 prompt」最大次數，超過視為迴圈（預設 `6`） |
| `AI_CLI_BREAKER_COOLDOWN_SEC` | 觸發後的開路冷卻秒數（預設 `120`） |
| `AI_CLI_DEFAULT_REASONING_EFFORT` | 覆寫 `config.json` 的 reasoning 預設值（見下節） |

## 模型目錄的出處與查詢時間

`models` payload 保留既有各 agent 字串陣列與 aliases，詳細來源看 `catalogV2`。
`catalogV2.entries[]` 保留 `id / agent / model / displayName / billingRoute / source / verifiedAt / routable`；
`catalogV2.agents[]` 每列是 `{ agent, binaryFound, source, verifiedAt, discoveryNote }`。
每列的 `verifiedAt` 與所屬 entries 一致，快取不會把原時間改成現在。

| source | 意思 |
|--------|------|
| `vendor-cli` | 此 process 這一輪或先前真的問過 CLI 的成功值；`verifiedAt` 是當時問到的時間 |
| `vendor-cli-cached` | 先前行程問到、存進磁碟的值，這一輪尚未確認；保留原 `verifiedAt` |
| `builtin-fallback` | 原始碼的靜態參考值，未經 vendor 確認；`verifiedAt` 是本次讀取靜態值的時間 |

**`agy models` 是網路呼叫，不是讀本機設定。** 2026-09-05 本機 agy 1.1.26 實測，
它先對 `https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` 做 eligibility check。
八次暖機耗時為 **1739 / 1755 / 1762 / 1838 / 1906 / 2487 / 2729 / 3972 ms**，
網路尾延遲可能超過 5 秒。舊實作每個 process 冷啟動與 60 秒快取到期後都以 `spawnSync`
重查，連 MCP 工具描述也會卡住整個 server；5 秒逾時後又把整輪降成 fallback。

現在 `buildCatalogV2()` 與 `getModelsPayload()` 維持同步，只讀記憶體／磁碟／靜態值，
同步堆疊永不 spawn。找得到 CLI 卻沒有此 process 的成功值時，會排一輪背景
`refreshCatalogV2()`，自己不等：**MCP `tools/list` 與 `set_config` 不等查詢；
MCP `models` 與 CLI `ai-cli models` 會先 `await refreshCatalogV2()` 才回 payload。**

`refreshCatalogV2({ force?: boolean })` 是非同步且在 process 內單飛：已有查詢就共用 Promise。
預設記憶體成功值在 **10 分鐘**內不重查，`force: true` 可忽略新鮮度。失敗保留成功值，
並在 `discoveryNote` 記下逾時、stderr 第一行非空文字或沒有模型 id 的原因。
agent 的 `discoverModels` 現在必須回 Promise、有逾時且永不 reject；可回模型陣列／null，
或 `{ models, note }`（失敗時 `models: null`）。`agy` 採後者提供診斷。

磁碟檔為 `join(CONFIG_DIR, 'catalog-cache.json')`，每個 agent 一筆
`{ models, verifiedAt, cliPath }`。寫入採同目錄 tmp + rename，讀取任何錯誤都忽略；
只有 **CLI 路徑相同且時間不超過 30 天**的磁碟值會被使用。
`vendor-cli-cached` 的 note 顯示「快取值：N 秒前問過 CLI；背景重新查詢中」，
最近一次背景失敗時附原因。沒有有效快取時才回 `builtin-fallback` 並說明原因。
`clearCatalogCache()` 只清記憶體，測試可用 `clearCatalogCache({ disk: true })` 一併刪磁碟檔。

## direct-api：自己接任何第三方 API

除了三個本機 CLI，這個框架還有一條 **direct-api** 路徑——它不啟動任何子程序，
直接在 Node 行程內打 HTTP，因此**任何 OpenAI-compatible 的 `/chat/completions` 端點都能接**：
OpenRouter、阿里雲 DashScope、DeepSeek、Groq、together.ai、vLLM / Ollama 之類的自架服務，
或你公司內部的 gateway。想加一家新的供應商**不需要改任何程式碼**，只要寫一筆設定。

### 設定檔

路徑 `~/.local/share/ai-cli/providers.json`（可用 `AI_CLI_PROVIDERS_PATH` 覆寫）：

```json
{
  "providers": {
    "openrouter": { "api_key": "sk-or-v1-..." },
    "dashscope":  { "api_key": "sk-..." },
    "deepseek":   { "base_url": "https://api.deepseek.com/v1", "api_key": "sk-..." },
    "local":      { "base_url": "http://127.0.0.1:11434/v1",   "api_key": "ollama" }
  }
}
```

- `api_key` 也接受寫成 `key` 或 `token`；`base_url` 也接受 `baseURL`。
- `openrouter` 與 `dashscope` 有**內建預設端點**，所以 `base_url` 可以省略：
  `https://openrouter.ai/api/v1`、`https://dashscope.aliyuncs.com/compatible-mode/v1`。
- 其他任何自訂名稱都必須自己給 `base_url`。缺 `base_url` 或 `api_key` 的那一筆會被視為無效。

### 怎麼呼叫

model 名稱用 **`<provider>-<model>`**，前綴就是 `providers.json` 裡的那個 key：

| model 參數 | 實際打到哪 |
|-----------|-----------|
| `or-qwen/qwen3.7-plus` | OpenRouter（`or` 是 `openrouter` 的內建簡寫） |
| `ds-qwen-max` | DashScope（`ds` 是 `dashscope` 的內建簡寫） |
| `deepseek-deepseek-chat` | 上面自訂的 `deepseek` provider |
| `local-llama3.1` | 上面自訂的 `local`（Ollama） |

前綴之後的整串都當成 model 名稱原樣送出，所以 `or-qwen/qwen3.7-plus` 裡的斜線沒問題。
**model 清單是動態的**——框架不維護任何白名單，供應商支援什麼就能填什麼；
`models` 工具的 `dynamicModelBackends` 只會告訴你有哪些前綴可用。

### 能做什麼、限制在哪

- **會用工具**：direct-api 不只是單次補全，它跑的是完整 agent loop——
  `read_file` / `write_file` / `bash` 等工具都能用，模型可以真的改檔案、跑指令。
- **支援 session**：`session_id` 會存在 `workFolder/.tmp/api_sessions`，可以續聊。
- **支援圖片**：prompt 裡寫 `[image:C:/path/to.png]` 會轉成 vision 訊息（png/jpg/webp/gif）。
- **想關掉工具**：prompt 開頭加 `[no-tools]`，就退化成單純問答。
- **不支援 `reasoning_effort`**：這個參數只對 claude / codex 有效。
- **每回合上限**：最多 30 次 API 呼叫、30 圈 tool loop，避免模型自己繞不出來。
- **金鑰保護**：任何錯誤訊息在回傳前都會把 api_key 換成 `[redacted]`。

> 從 OpenCode 遷移：若 `providers.json` 不存在但 `~/.local/share/opencode/auth.json` 在，
> 框架會自動轉檔一次。

## 使用者設定檔（config.json）

路徑：`~/.local/share/ai-cli/config.json`（與 `providers.json` 同一層）。
每次都重新讀檔、以檔案內容當快取鍵（省下的只有 JSON 解析），改完檔不必重啟 MCP server。
每個高階操作（一次 `run` 的指令組裝、一次 `models`）只載入一份 snapshot，
所以同一次操作內看到的一定是同一份設定。

讀不到或讀壞了的處理方式分三種，刻意不一樣：

| 情況 | 行為 |
|------|------|
| **結構性**讀不到（`ENOENT` / `ENOTDIR` / `EISDIR` / `ELOOP` / `ENAMETOOLONG`） | 退回內建預設，不會讓 `run` 失敗 |
| 內容不是合法 JSON 物件 | 退回內建預設，並清掉快取（避免壞掉的舊值之後被當成 last-good 復活） |
| **暫時性**讀取錯誤（`EBUSY` / `EPERM` / `EACCES`…） | **沿用上一次成功讀到的設定**，不退回內建值 |

分界點是「再試一次有沒有可能成功」，不是「錯誤嚴不嚴重」：
結構性錯誤不會自己好，沿用舊設定只會讓一份永遠讀不到的設定無限期存活；
暫時性錯誤（別的 process 正在 rename、防毒掃描鎖檔）退回內建值則等於讓這一次 run
悄悄換成另一個 model 而沒有人會察覺。目前生效的狀態可從 `models` 的 `userConfig.status` 查看
（`fresh` / `missing` / `stale`+`errorCode` / `error`）。

反過來，**寫入**時的原則相反 —— `set_config` 若讀不到或讀到壞掉的設定檔會**明確失敗**，
不會拿空基底套上變更寫回去（那會把原有設定與未知欄位整份吃掉）。

檔案帶 UTF-8 BOM（Windows 記事本、PowerShell 5.1 的 `Set-Content` 都會產生）也能正常讀取。

```json
{
  "defaultReasoningEffort": "medium",
  "aliasReasoningEffort": {
    "claude-ultra": "medium",
    "codex-ultra": "medium"
  },
  "aliasModel": {
    "codex-ultra": "gpt-5.6-terra"
  }
}
```

| 欄位 | 用途 |
|------|------|
| `defaultReasoningEffort` | 呼叫端沒帶 `reasoning_effort` 時，所有支援 reasoning 的 agent 套用的預設 |
| `aliasReasoningEffort` | 針對特定 model/alias 的覆蓋，優先於 `defaultReasoningEffort` |
| `aliasModel` | 把 alias 重新指向另一個 model，優先於 `catalog.ts` 寫死的 `MODEL_ALIASES`（見下節） |

檔案中它不認識的欄位會原封保留，`set_config` 寫入時也不會被吃掉。

reasoning 預設值的優先序（高 → 低）：

1. 呼叫端明確傳入的 `reasoning_effort`
2. `AI_CLI_DEFAULT_REASONING_EFFORT` 環境變數
3. `config.json` 的 `aliasReasoningEffort[model]`
4. `config.json` 的 `defaultReasoningEffort`
5. 內建 ultra alias 預設（`claude-ultra` = `max`、`codex-ultra` = `max`）

兩者行為不同，這點是刻意的：

- **明確傳入**的值不合法會**丟錯**（維持原本行為）。
- **設定檔／環境變數**推導出的預設，若該 agent 不支援 reasoning（antigravity /
  direct-api）或該值不在其允許集合（例如 claude 不吃 `ultra`），會**靜默略過**、
  改用該 CLI 自身預設。全域偏好不該讓個別 run 整個失敗。

目前生效的設定可從 `models` 工具回傳的 `userConfig` 欄位查看；`aliases[].defaultReasoningEffort`
也會反映套用設定後的實際值，`userConfig.builtinAliasReasoningEffort` 則保留內建值供對照。

### 設定檔的已知限制

- **手動編輯的 `aliasModel` 不會被驗證**：`set_config` 會擋掉不存在的 model（否則打錯字會被
  catch-all 的 claude agent 靜默接走），但直接編輯 `config.json` 沒有這道關卡。
  改完可以用 `models` 檢查 —— 每筆 alias 都會顯示實際 `resolvesTo` 與推算出的 `agent`，
  被靜默接走的打錯字會顯示成 `agent: claude`。
- **多個 process 同時寫入會遺失更新**：`set_config` 是無鎖的 read-modify-rename，
  兩個 MCP server 同時改不同欄位時，後 rename 的會覆蓋掉前一個的修改
  （tmp 檔名帶 pid 只避免 tmp 互撞，不解決這件事）。實務上 `set_config` 極少並發。

## alias 重新指向（免 rebuild、免重啟）

內建 alias 寫在 `src/models/catalog.ts` 的 `MODEL_ALIASES`：

| alias | 內建指向 |
|-------|----------|
| `claude-ultra` | `opus` |
| `codex-ultra` | `gpt-6-astra` |
| `agy-ultra` / `antigravity-ultra` | `Gemini 3.1 Pro (High)` |

> **`gpt-6-astra` 需要 codex-cli 0.153 以上。** 0.151.0 的模型快取雖然列得出它，實跑會被 API 以
> `requires a newer version of Codex` 拒絕（2026-09-05 實測；0.153.4 可用）。`codex-ultra` 既然改指它，
> 舊版 CLI 上呼叫 `codex-ultra` 也會失敗——升級 CLI，或用下面的 `aliasModel` 暫時把它指回 `gpt-5.6-sol`。

`config.json` 的 `aliasModel` 可以覆寫它。解析優先序（高 → 低）：

1. `config.json` 的 `aliasModel[alias]`
2. 內建 `MODEL_ALIASES[alias]`
3. 原樣（不是 alias 就當成 model 名稱直接送出）

**為什麼改完立刻生效**：`resolveModelAlias()` 是每次組指令時才呼叫（不是啟動時算好的常數），
而設定檔每次都會重讀，所以下一次 `run` 就會改用新的模型與路由，不必 `npm run build`、不必重連 MCP。
（實際怎麼傳給 CLI 依 agent 而定：claude / codex 走 `--model`，direct-api 走 API 請求，
agy 則完全不吃模型選擇 —— 見下方已知限制。）

### 用 `set_config` 工具寫入

| 參數 | 用途 |
|------|------|
| `alias_model` | `{"codex-ultra": "gpt-5.6-terra"}` — 重新指向 |
| `alias_reasoning_effort` | `{"codex-ultra": "high"}` — 該 alias 的預設 reasoning |
| `default_reasoning_effort` | 全域 reasoning 預設 |
| `unset` | `["codex-ultra"]` 會**同時**清掉該 alias 的 model 與 reasoning 兩種覆寫；`["defaultReasoningEffort"]` 清全域預設 |

回傳與 `models` 相同的 payload，可以立刻看到生效狀態。`models` 的每筆 alias 附帶
`source`（`builtin` / `config`），**被 config 重指的那幾筆**額外附 `builtinResolvesTo`
（沒被重指就沒有這個欄位），且 `agent` 欄位是**依實際生效的 model 動態推算**
——alias 被跨 agent 重指（例如 `codex-ultra` → `opus`）時才不會回報錯的 agent。

### 驗證是刻意從嚴的

claude agent 的 `matchesModel` 是 registry 最後一位的 catch-all（永遠回 `true`），
不擋的話**打錯字的 model 會被靜默送去 claude**。因此 `set_config` 只接受：
被某個非 fallback agent 認得的 model，或 direct-api 真的解析得出來的 provider-prefixed 名稱
（`or-` / `ds-` 這種空 model 會被拒絕）。另外 alias 只解析一層，所以**不接受把 alias 當 target**
（`codex-ultra` → `agy-ultra` 會讓該 alias 名稱被原樣當成 model 送出去）。

### 已知限制

- **antigravity（agy）不吃 `--model`**：其 CLI 沒有這個旗標，實際模型由登入帳號的 Google AI tier 決定。
  重指 `agy-ultra` / `antigravity-ultra` 只改變回報內容，不改變實際執行的模型。
- 模型的**自報名稱不可信**（問 `gpt-5.6-terra`「你是哪個模型」它會說 GPT-5）。要驗證 `--model`
  真的送出去，把 alias 指到一個不存在但能過驗證的名稱（如 `gpt-5.6-doesnotexist`）再 `run`，
  看 CLI 是否回報該模型不支援。
- **Kiro 與 Forge 已於 5.0.0 移除**（Kiro 沒額度、Forge 從沒安裝過）。`kiro`、`kiro-*`、
  `forge` 這些名稱現在會**明確報錯**，而不是被 catch-all 的 claude 靜默接走。
  注意 `forge-<model>` 不受影響——那會被讀成 direct-api 的 provider `forge` 加上 model。
- 回歸測試：`node verify-alias-config.mjs`（65 項，已納入 `npm test`）。

## 等待端怎麼知道 AI 還活著

`wait` 逾時只代表這次觀察時間用完，程序會繼續跑。以前兩條路徑都丟
`Timed out after N seconds`，MCP 把它包成 InternalError；呼叫端 AI 容易將它當成任務失敗而遺棄 pid。
現在 MCP 與 CLI 都**回傳目前結果的陣列**，只有逾時時仍 `running` 的項目帶 `timedOut: true`。
不存在的 pid 仍是錯誤。`completed` / `failed` / `lost` 都不帶 `liveness` 或 `timedOut`。

`get_result`、`wait`、`list_processes` 的 running 項目都有同一個 `liveness` 物件，compact 與 verbose 都會回：

| 欄位 | 型別 | 意義 |
|------|------|------|
| `alive` | boolean | MCP：尚未收到 close；file：OS PID 存在且沒有 exit-status。它表示程序存活，不能保證模型正在產生答案 |
| `elapsedSec` | number | 從啟動到現在的秒數，可含小數 |
| `sinceLastOutputSec` | number / null | 距最後 stdout / stderr chunk 的秒數；從未輸出是 null |
| `stdoutBytes` | number | 收到的 stdout 位元組數；PTY 合併的輸出也計入 stdout |
| `stderrBytes` | number | 收到的 stderr 位元組數 |
| `lastEvent` | string / null | 最後一個有意義事件的一行摘要，最多 120 字；Codex 含事件 type、item.type 及最多 80 字的 command / text，Claude 含 type 與工具名，agy 去 ANSI，direct-api 取 type |
| `eventCount` | number | 已解碼的完整、有意義事件數；空行、壞 JSON 與未完成半行不計 |
| `hint` | string | 給 AI 的英文建議：starting up、最近有輸出、活著但沉默，或等待結束 metadata |

`list_processes`（CLI 為 `ps`）還會在 running 項目直接放 `elapsedSec`、`sinceLastOutputSec`、`lastEvent`，
方便快速掃描。已結束的項目只在知道結束時間時附 `elapsedSec`，該時間不再隨輪詢增加。
file 路徑沿用 `lost`：PID 消失且沒有結束回報表示結果未知，不能當成 failed。
PTY 在 OS PID 消失到寫下 exit-status 之間，可能短暫顯示 running 且 `alive: false`。

檔案版從 stdout / stderr 檔的 size 與非空檔 mtime 推導統計，不需要啟動它的 CLI 留在記憶體。
內部 `lastOutputAt` 是 ISO 時間；file 以 mtime 近似，兩個串流的事件先後也只能近似。
為了讓 `eventCount` 完整，新讀端首次逐塊掃描輸出檔，同一讀端接著只讀新增 bytes。

建議每次 `wait` 使用 **90 秒或更短**的 timeout，持續保存原 pid 並重複等待。
只要 `liveness.alive` 是 true，就不要因為逾時而遺棄它或另啟一份相同任務。
需要看即時訊息／工具事件時呼叫 `peek`；它只觀察這次視窗的新事件，不回放歷史，也不會回傳 Codex reasoning 內容。

以下假設已有連線的 MCP `client` 與 `run` 回傳的 `pid`：

```js
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content[0].text);
  return JSON.parse(response.content[0].text);
};

for (;;) {
  const [result] = await call('wait', { pids: [pid], timeout: 90 });
  if (result.status !== 'running') {
    console.log(result); // completed / failed / lost：依實際狀態處理
    break;
  }
  console.log(result.liveness.hint);
  console.log(await call('peek', {
    pids: [pid], peek_time_sec: 10, include_tool_calls: true,
  }));
  // 保留 pid，回到 wait；timedOut 不是任務失敗。
}
```

CLI 同樣印 JSON：`ai-cli wait <pid> --timeout 90` 的 exit code 為 **3 = 逾時且仍 running**、
**0 = 全部已結束**（不代表每個任務成功）、**1 = 呼叫錯誤**。輪詢程式要接受 3 並繼續等。

**codex 在推理時零輸出是正常的。** `exec --json` 送出 `turn.started` 後，到第一個 item 完成之前
可能幾分鐘沒有 stdout；Claude 推理時也可能沉默。因此有輸出但靜默未滿 120 秒時 hint 建議 keep waiting；
超過 120 秒且 alive 時會說明 reasoning 可能沒有輸出。完全沒輸出時，前 30 秒顯示 starting up，
30 秒後仍 alive 則建議繼續等待或 peek。

使用者於 **2026-09-05 本機 trivial prompt 實測**：啟動到 `thread.started` 約 **0.3–1.2 秒**；
載入 `~/.codex/config.toml` 的 4 個 MCP servers（含 ai-cli 自己），比 `--ignore-user-config` 整體多 **1–2 秒**；
gpt-6-astra medium 回一個字約 **5.7 秒**，gpt-5.4-mini low 約 **6.5 秒**。
這些是單機量測，主要等待發生在模型端推理；本功能讓等待端看得見程序狀態，不改模型速度。
回歸驗證使用 stub，不重打真實供應商：`node verify-liveness.mjs`。

## 那份程式碼到底驗證了沒

跟 `liveness` 同一個哲學，往上一層：**呼叫端是 AI，它只看得到工具回傳**。
回傳沒說「這次改了程式碼但沒跑過任何測試」，它就會把子 agent 的「我做完了」當成做完了。

所以 `run` / `wait` / `get_result` 的回傳都帶 `verification`，**compact 模式也不拿掉**——
一個只在 `verbose` 才出現的欄位，等於沒有人會看到。

| 狀態 | 意思 |
|---|---|
| `not_applicable` | 沒有改到程式碼檔，本來就不需要驗證。 |
| `not_observed` | 改了程式碼卻沒有後續驗證，或這個 agent 根本沒有結構化工具紀錄（agy）。**看不到不等於沒發生**。 |
| `passed` | 在**最後一次修改之後**跑過測試／建置／型別檢查並成功。 |
| `failed` | 有跑而且失敗了。這份工作不能當成完成。 |
| `waived` | 改了沒驗證，但有明確記下理由。**永遠不會蓋過 `failed`**。 |
| `pending` | 還在跑。這時候講任何其他狀態都是猜的。 |

**刻意不是布林值。** `verified: false` 沒辦法區分「沒碰程式碼」「碰了但我看不到有沒有檢查」
「檢查了而且壞了」——這三件事對呼叫端的下一步完全不同。

順序是這套判定的全部重點：驗證必須發生在**最後一次修改之後**才算數，
否則「先跑測試、再改程式碼」會回報通過。證據物件會列出最後一次修改是什麼、
之後跑了哪些驗證、以及有幾次過期的驗證被忽略。

### 隨附的 Claude Code plugin

同一套判定也用在你自己的回合上，透過隨附的 plugin（`plugin/`，經
`.claude-plugin/marketplace.json` 發佈）。它的 `Stop` hook 會在「這個回合改了程式碼卻
沒驗證」時**擋一次**，要求補跑測試或寫明不驗證的理由。

```bash
/plugin marketplace add moerasermax/ai-cli-mcp-source
/plugin install ai-cli-verification-gate@ai-cli-mcp
```

> ⚠️ **plugin 更新也要手動。** 安裝時 Claude Code 把 `plugin/` 複製到
> `~/.claude/plugins/cache/`，之後 `git pull` 不會動它——判定邏輯改了、push 了，
> 那台機器仍跑安裝當下那份。`doctor.plugin` 的 `upToDate` 會告訴你，
> 過時就重裝一次：`/plugin uninstall <key>` 然後 `/plugin install <key>`。

硬性規則：**一律 exit 0**，絕不弄壞使用者的 session；**最多擋一次**（官方的
`stop_hook_active` 旗標就是為此存在，第二次一律放行並記成 `waived`）；
**無法可靠判定時不擋**（讀不到 transcript、找不到判定模組都直接放行）。
漏擋的代價，遠低於誤擋一份本來沒問題的工作。

為什麼需要它——這是實測不是臆測：掃 2026-09-06 13:00 起 44 小時、178 條 transcript、
26,003 筆 usage 記錄後，**有改到程式碼的工作段裡 31.7% 完全沒跑任何 test/build**，
而且這個比例隨上下文長度上升（峰值 0-200k 是 5%、600-800k 是 59%）。
有驗證的工作段返工率 59.2%、平均 4.67 圈。
同一份資料裡，首次驗證通過率在各上下文區間之間**沒有趨勢**（89/77/86/78/86%）——
長上下文並沒有讓程式碼變差，只是讓同一件工作從 1.43M 額度變成 11.64M。

**只算工作目錄底下的修改**：ai-cli 這側用派工的 `workFolder`，plugin 這側用 hook 事件的
`cwd`。寫到暫存目錄的一次性分析腳本不會觸發閘門——那種腳本本來就沒有測試可跑。
（相對路徑一律算在專案內，它本來就相對於工作目錄解析。）

### 其他機器怎麼知道要裝

自動更新只散布**程式碼**，不散布**啟用狀態**：plugin 的檔案會跟著 `git pull` 出現在每台機器，
但 Claude Code 要不要載入它記在各機器自己的 `~/.claude/settings.json`。
ai-cli 不去改那個檔——一個派工工具靜默改寫使用者的 Claude Code 設定是壞設計。

所以 ai-cli 只負責**偵測並說出來**：

- `doctor.plugin` 一律回報 `{ bundled, enabled, marketplaceAdded, version, reason, notice }`，
  主動查才看得到，不吵。
- `run` 的回傳多一個 `pluginNotice`，在「檔案在、這台機器沒啟用」時提醒，
  **每 3 天最多一次**（`AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC` 可覆寫）。
  只提醒一次不夠——新機器上第一次跳出來時多半在忙別的，錯過就永遠看不到；
  每次 run 都喊又太吵。真的啟用後旗標會被清掉，日後若停用會重新開始提醒。
- 讀不到或無法解析 `settings.json` 時只填 `reason`，**不提醒**——那可能根本不是 Claude Code 環境。

判定結果會寫進 `AI_CLI_STATE_DIR/verification-gate.jsonl`，**兩層寫同一份檔案**，
用 `source`（`ai-cli` / `hook`）區分。合起來才是這台機器完整的品質基線。
只記錄、不彙總、不外送——跨機器基線需要明確的同步端與隱私政策，那是另一件事。

已知限制：只看得到 transcript 裡的工具事件。若程式碼是被子行程間接改掉的
（例如跑一支會自己改檔的腳本），這裡看不到，會回 `not_applicable`。
這是刻意的取捨——寧可漏擋，也不要誤擋。

## AI 啟動熔斷器（circuit breaker）

為避免「呼叫端框架 bug 造成無窮迴圈、對 AI 供應商狂打請求、進而被誤判為共用帳號或濫用而違規」，
框架在啟動任何子程序前會先經過熔斷器（`src/core/circuit-breaker.ts`）。它偵測兩種迴圈特徵：

- **爆量（rate）**：滑動視窗內啟動次數超過 `AI_CLI_BREAKER_MAX_STARTS`。
- **重複（duplicate）**：視窗內「同一 agent + 同一 prompt」次數超過 `AI_CLI_BREAKER_DUP_LIMIT`。

觸發後進入冷卻（`AI_CLI_BREAKER_COOLDOWN_SEC`），期間擋下所有啟動並回傳清楚錯誤，冷卻結束自動恢復。
所有門檻見上方環境變數表；正常用量不會誤觸。驗證：`npm run build && node verify-breaker.mjs`。

## 掛到 Claude Code

最快的方式（在 repo 根目錄執行，`$PWD` 會自動展開成本機的絕對路徑）：

```bash
# bash / git bash
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```

```powershell
# PowerShell
claude mcp add ai-cli -s user -- node "$PWD\dist\server.js"
```

或手動把 `~/.claude.json` 的 `mcpServers.ai-cli` 指向（`<repo>` 換成你 clone 的絕對路徑）：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["<repo>/dist/server.js"],
  "env": {}
}
```

### 三個入口是等價的

`dist/server.js`（官方推薦）、`dist/bin/ai-cli-mcp.js`、`node dist/bin/ai-cli.js mcp`
三者對外行為完全相同，`verify-mcp.mjs` 每次都會三個都測過。

> **4.1.2 之前 `ai-cli mcp` 是壞的**：`runMcpServer()` 在 transport 一接上就 resolve，
> 而 `bin/ai-cli.js` 會在那之後呼叫 `process.exit()`，於是 server 在 handshake 完成前
> 就自殺，client 只看得到 `MCP error -32000: Connection closed`。另外兩個入口沒有
> `process.exit`，所以只是碰巧沒事。若你的設定還指著 `ai-cli.js mcp` 且版本低於
> 4.1.2，升級或改指 `dist/server.js` 皆可。

## 與舊 dist 的差異

- 移除了已壞掉的 gemini 殘留（舊 dist 的 cli-parse / app-cli 還 import 不存在的
  `parseGeminiOutput` / `findGeminiCli`，本版一併修正）。
- usage 外掛路徑由寫死改為 `AI_CLI_USAGE_PLUGIN_BIN` 環境變數。
- ConPTY 與各 agent 行為以 registry 重構。3.0.0 當時對外 MCP 行為與舊 dist 等價，
  **但之後已經分歧**：4.0.0 移除了 OpenCode agent 與 `oc-*` model routing（改用 direct-api），
  並新增 `set_config` 與 `query_usage` 兩個工具（目前共 11 個）。詳見 `CHANGELOG.md`。
