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
| `AI_CLI_STATE_DIR` | CLI detached job 的狀態目錄（預設 `~/.local/state/ai-cli`） |
| `AI_CLI_USAGE_PLUGIN_BIN` | `ai-cli usage` 外掛的 .mjs 絕對路徑 |
| `CLAUDE_CLI_NAME` / `CODEX_CLI_NAME` / `AGY_CLI_NAME` | 覆寫各 CLI 的指令名稱或絕對路徑 |
| `AI_CLI_PROVIDERS_PATH` | direct-api providers.json 路徑（預設 `~/.local/share/ai-cli/providers.json`） |
| `AI_CLI_BREAKER_DISABLED=true` | 停用 AI 啟動熔斷器（預設啟用） |
| `AI_CLI_BREAKER_MODE` | `block`（預設，觸發即擋下並回報）或 `warn`（只警告不擋） |
| `AI_CLI_BREAKER_WINDOW_SEC` | 熔斷器滑動視窗秒數（預設 `60`） |
| `AI_CLI_BREAKER_MAX_STARTS` | 視窗內最大啟動次數，超過視為爆量（預設 `30`） |
| `AI_CLI_BREAKER_DUP_LIMIT` | 視窗內「同一 agent + 同一 prompt」最大次數，超過視為迴圈（預設 `6`） |
| `AI_CLI_BREAKER_COOLDOWN_SEC` | 觸發後的開路冷卻秒數（預設 `120`） |
| `AI_CLI_DEFAULT_REASONING_EFFORT` | 覆寫 `config.json` 的 reasoning 預設值（見下節） |

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
