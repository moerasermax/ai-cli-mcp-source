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
│   ├─ peek.ts / peek-extractor.ts / process-result.ts / reasoning.ts / ansi.ts / debug.ts
│   └─ doctor.ts              # doctor + 解析所有 CLI 路徑
├─ models/
│   └─ catalog.ts         # model 清單 / alias / models payload
├─ plugins/
│   └─ usage.ts           # 查額度外掛橋接（路徑由環境變數設定）
├─ app/
│   ├─ mcp.ts             # MCP server（9 個工具）
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
- ConPTY 與各 agent 行為以 registry 重構，但對外 MCP 行為與舊 dist 等價。
