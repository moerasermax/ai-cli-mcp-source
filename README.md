# ai-cli-mcp（自有可控版）

把 Claude / Codex / Antigravity(agy) / Kiro / Forge 等本機 AI CLI
以及 direct OpenAI-compatible API agent 包成 MCP 工具，支援背景 job。這是**從原始碼自行維護**的版本，採用 registry-based
架構，新增 AI agent 只需新增一個檔案。

## 架構

```
src/
├─ server.ts              # 預設進入點（啟動 MCP server）
├─ agents/                # ★ 每個 AI 一個檔，新增 AI 就加一個檔
│   ├─ types.ts               # AgentDefinition 介面（可擴充的核心契約）
│   ├─ registry.ts            # 中央註冊表（新增 agent 在此 import + 列入陣列）
│   ├─ claude.ts / codex.ts / antigravity.ts / kiro.ts / forge.ts / direct-api.ts
├─ core/                  # 框架本體，新增 agent 時「不用動」
│   ├─ command-builder.ts     # model routing + 指令組裝協調
│   ├─ process-service.ts     # 記憶體版 job 管理（MCP 用）
│   ├─ file-process-service.ts# 檔案版 job 管理（ai-cli CLI 的 detached 用）
│   ├─ pty-runner.ts          # ConPTY（agy 等需要真實 TTY 的 CLI）
│   ├─ binary-resolver.ts     # CLI 二進位解析
│   ├─ user-config.ts        # ~/.local/share/ai-cli/config.json 讀寫（依內容快取）
│   ├─ circuit-breaker.ts    # AI 啟動熔斷器
│   ├─ peek.ts / peek-extractor.ts / process-result.ts / reasoning.ts / ansi.ts / debug.ts
│   └─ doctor.ts              # doctor + 解析所有 CLI 路徑
├─ models/
│   └─ catalog.ts         # model 清單 / alias / models payload
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
npm install
npm run build      # tsc → dist/
npm run dev        # tsx 直跑 src/server.ts（改完即生效，不用 build）
npm run typecheck  # 只型別檢查
```

## 新增一個 AI agent

1. 複製 `src/agents/forge.ts`（最單純）成 `src/agents/<name>.ts`，實作 `AgentDefinition`：
   - `id` / `models` / `matchesModel` / `binary` / `reasoning` / `buildCommand` / `parseOutput`
   - 需要真實 TTY → 設 `win32SpawnMode: 'pty'`（參考 `antigravity.ts`）
   - 是真實 .exe（非 npm shim）→ 設 `win32DirectExec: true`（參考 `kiro.ts`）
2. 在 `src/agents/registry.ts` import 並加進 `AGENTS` 陣列（claude 永遠最後，它是 fallback）。
3. 在 `src/agents/types.ts` 的 `AgentId` 加上新 id；若 agent 需要 CLI binary，更新
   `core/doctor.ts` 的 `CliPaths` 回傳欄位。
4. `npm run build`。

## 環境變數

| 變數 | 用途 |
|------|------|
| `MCP_CLAUDE_DEBUG=true` | 開啟 debug 日誌到 stderr |
| `AI_CLI_STATE_DIR` | CLI detached job 的狀態目錄（預設 `~/.local/state/ai-cli`） |
| `AI_CLI_USAGE_PLUGIN_BIN` | `ai-cli usage` 外掛的 .mjs 絕對路徑 |
| `CLAUDE_CLI_NAME` / `CODEX_CLI_NAME` / `AGY_CLI_NAME` / `KIRO_CLI_NAME` / `FORGE_CLI_NAME` | 覆寫各 CLI 的指令名稱或絕對路徑 |
| `AI_CLI_PROVIDERS_PATH` | direct-api providers.json 路徑（預設 `~/.local/share/ai-cli/providers.json`） |
| `AI_CLI_BREAKER_DISABLED=true` | 停用 AI 啟動熔斷器（預設啟用） |
| `AI_CLI_BREAKER_MODE` | `block`（預設，觸發即擋下並回報）或 `warn`（只警告不擋） |
| `AI_CLI_BREAKER_WINDOW_SEC` | 熔斷器滑動視窗秒數（預設 `60`） |
| `AI_CLI_BREAKER_MAX_STARTS` | 視窗內最大啟動次數，超過視為爆量（預設 `30`） |
| `AI_CLI_BREAKER_DUP_LIMIT` | 視窗內「同一 agent + 同一 prompt」最大次數，超過視為迴圈（預設 `6`） |
| `AI_CLI_BREAKER_COOLDOWN_SEC` | 觸發後的開路冷卻秒數（預設 `120`） |
| `AI_CLI_DEFAULT_REASONING_EFFORT` | 覆寫 `config.json` 的 reasoning 預設值（見下節） |

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
5. 內建 ultra alias 預設（`claude-ultra` = `max`、`codex-ultra` = `xhigh`）

兩者行為不同，這點是刻意的：

- **明確傳入**的值不合法會**丟錯**（維持原本行為）。
- **設定檔／環境變數**推導出的預設，若該 agent 不支援 reasoning（antigravity / kiro /
  forge / direct-api）或該值不在其允許集合（例如 codex 不吃 `max`），會**靜默略過**、
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
| `codex-ultra` | `gpt-5.6-sol` |
| `agy-ultra` / `antigravity-ultra` | `Gemini 3.1 Pro (High)` |
| `kiro-ultra` | `kiro-default` |

`config.json` 的 `aliasModel` 可以覆寫它。解析優先序（高 → 低）：

1. `config.json` 的 `aliasModel[alias]`
2. 內建 `MODEL_ALIASES[alias]`
3. 原樣（不是 alias 就當成 model 名稱直接送出）

**為什麼改完立刻生效**：`resolveModelAlias()` 是每次組指令時才呼叫（不是啟動時算好的常數），
而設定檔每次都會重讀，所以下一次 `run` 就會改用新的模型與路由，不必 `npm run build`、不必重連 MCP。
（實際怎麼傳給 CLI 依 agent 而定：claude / codex / kiro 走 `--model`，direct-api 走 API 請求，
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
（`codex-ultra` → `kiro-ultra` 會被 kiro 剝成 `--model ultra`）。

### 已知限制

- **antigravity（agy）不吃 `--model`**：其 CLI 沒有這個旗標，實際模型由登入帳號的 Google AI tier 決定。
  重指 `agy-ultra` / `antigravity-ultra` 只改變回報內容，不改變實際執行的模型。
- 模型的**自報名稱不可信**（問 `gpt-5.6-terra`「你是哪個模型」它會說 GPT-5）。要驗證 `--model`
  真的送出去，把 alias 指到一個不存在但能過驗證的名稱（如 `gpt-5.6-doesnotexist`）再 `run`，
  看 CLI 是否回報該模型不支援。
- 回歸測試：`node verify-alias-config.mjs`（49 項，已納入 `npm test`）。

## AI 啟動熔斷器（circuit breaker）

為避免「呼叫端框架 bug 造成無窮迴圈、對 AI 供應商狂打請求、進而被誤判為共用帳號或濫用而違規」，
框架在啟動任何子程序前會先經過熔斷器（`src/core/circuit-breaker.ts`）。它偵測兩種迴圈特徵：

- **爆量（rate）**：滑動視窗內啟動次數超過 `AI_CLI_BREAKER_MAX_STARTS`。
- **重複（duplicate）**：視窗內「同一 agent + 同一 prompt」次數超過 `AI_CLI_BREAKER_DUP_LIMIT`。

觸發後進入冷卻（`AI_CLI_BREAKER_COOLDOWN_SEC`），期間擋下所有啟動並回傳清楚錯誤，冷卻結束自動恢復。
所有門檻見上方環境變數表；正常用量不會誤觸。驗證：`npm run build && node verify-breaker.mjs`。

## 掛到 Claude Code

編譯後，將 `~/.claude.json` 的 `mcpServers.ai-cli` 指向：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["C:\\Users\\Moera\\ai-cli-mcp-source\\dist\\server.js"],
  "env": {}
}
```

## 與舊 dist 的差異

- 移除了已壞掉的 gemini 殘留（舊 dist 的 cli-parse / app-cli 還 import 不存在的
  `parseGeminiOutput` / `findGeminiCli`，本版一併修正）。
- usage 外掛路徑由寫死改為 `AI_CLI_USAGE_PLUGIN_BIN` 環境變數。
- ConPTY 與各 agent 行為以 registry 重構。3.0.0 當時對外 MCP 行為與舊 dist 等價，
  **但之後已經分歧**：4.0.0 移除了 OpenCode agent 與 `oc-*` model routing（改用 direct-api），
  並新增 `set_config` 與 `query_usage` 兩個工具（目前共 11 個）。詳見 `CHANGELOG.md`。
