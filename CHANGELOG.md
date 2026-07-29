# 變更紀錄（Changelog）

本檔記錄所有對使用者/協作者可見的改動。格式參考
[Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循
[語意化版本](https://semver.org/lang/zh-TW/)。每筆結尾以括號標註作者。

維護規則見 [CONTRIBUTING.md](./CONTRIBUTING.md)：**每次改動都要在此補一行。**

## [Unreleased]

### 變更
- **ultra alias 的預設指向**：`codex-ultra` 由 `gpt-5.5` 改為 `gpt-5.6-sol`；
  `agy-ultra` / `antigravity-ultra` 由 `agy-default` 改為 `Gemini 3.1 Pro (High)`。
  後者僅影響 `models` 的回報 —— agy CLI 不接受 `--model`，實際模型仍由登入帳號的
  Google AI tier 決定。（Claude，moerasermax 指示）

### 新增
- **model alias 可在 runtime 重新指向，免 rebuild、免重啟**：`config.json` 新增 `aliasModel` 欄位
  （例如 `{"codex-ultra": "gpt-5.6-terra"}`），優先於 `models/catalog.ts` 寫死的 `MODEL_ALIASES`。
  `resolveModelAlias()` 是每次組指令時才呼叫、設定又以 mtime 快取，所以改完下一次 `run` 立即生效。
  同時新增 MCP 工具 **`set_config`** 負責寫入（`alias_model` / `alias_reasoning_effort` /
  `default_reasoning_effort` / `unset`），回傳與 `models` 相同的 payload 讓呼叫端立刻看到生效狀態。
  寫入採「讀原始 JSON → patch → tmp + rename」，會保留設定檔中它不認識的欄位。
  驗證上刻意擋掉未知 model：claude agent 的 `matchesModel` 是 catch-all，不擋的話打錯字會被
  **靜默送去 claude**，因此 `set_config` 只接受某個非 fallback agent 認得的 model 或
  direct-api 的 provider-prefixed 名稱。`models` 的 aliases 每筆新增 `source`
  （builtin/config）與 `builtinResolvesTo`，且 `agent` 欄位改為依實際生效的 model 動態推算
  ——alias 被跨 agent 重指（如 `codex-ultra`→`opus`）時才不會回報錯的 agent。
  實測：不重啟直接把 `codex-ultra` 指到 `gpt-5.6-doesnotexist`，codex CLI 確實回報
  `The 'gpt-5.6-doesnotexist' model is not supported`，證明 `--model` 真的帶著新值送出。
  注意 antigravity（agy）不吃 `--model`，重指 `agy-ultra` 只影響回報、不影響實際執行。
  獨立稽核（@codex，xhigh）抓出並已修掉四個洞：(1) `or-` / `ds-` 這種空 direct-api model
  能通過 `matchesModel` 但 run 時必炸 —— 改為要求 `resolveDirectApiModel` 真的解析得出來；
  (2) 把 alias 名稱當 target（如 `codex-ultra`→`kiro-ultra`）會因為 alias 只解析一層而被
  kiro 剝成 `--model ultra` —— 改為直接拒絕 alias 當 target；(3) `constructor` / `toString`
  等 prototype key 在 `model in MODEL_ALIASES` 與 `map[key]` 下會被誤判為合法 alias 或取到函式
  —— 全部改用 `hasOwnProperty` 檢查；(4) `updateUserConfig` 的 tmp 檔名固定，跨 process 並發
  寫入會互相覆蓋且 rename 拿到 ENOENT —— 改為帶 pid 並在失敗時清理。另修正 alias 被重指到
  不支援 reasoning 的 agent 時，`models` 仍回報一個不會生效的 `defaultReasoningEffort`。（Claude）
- **alias 熱切換回歸測試 `verify-alias-config.mjs`**：28 項斷言，涵蓋 `isKnownModelTarget` /
  `resolveModelAlias` 的邊界（含上述稽核抓出的四個案例）、「同一個 process 內改設定，
  `buildCliCommand` 組出的 `--model` 與 agent 立即跟著變」，以及真的起一個 MCP server
  走 stdio JSON-RPC 驗 `set_config` 的驗證／寫入／`unset`／未知欄位保留。
  執行前會備份、結束後還原 `config.json`。（Claude）
- **使用者持久化設定 `config.json`**：新增 `~/.local/share/ai-cli/config.json`（與 providers.json
  同層），支援 `defaultReasoningEffort` 與 `aliasReasoningEffort`，可持久覆寫原本寫死的
  ultra alias 預設（`claude-ultra`=max / `codex-ultra`=xhigh）。優先序為：呼叫端明確參數 >
  `AI_CLI_DEFAULT_REASONING_EFFORT` 環境變數 > `aliasReasoningEffort` > `defaultReasoningEffort` >
  內建預設。設定檔缺失／格式錯誤一律靜默退回內建值；由設定推導出的預設若該 agent 不支援
  reasoning 或值不在其允許集合，會靜默略過而非丟錯（明確傳入的不合法值仍照舊丟錯）。
  設定以 mtime 快取，改檔免重啟。`models` 工具新增 `userConfig` 欄位回報目前生效設定。（Claude）
- **direct-api agent**：移除 OpenCode CLI agent，新增不啟動子程序的 OpenAI-compatible API agent。
  支援 `or-<model>`（OpenRouter）、`ds-<model>`（DashScope）與 providers.json 中的
  `<provider>-<model>`，設定檔位於 `~/.local/share/ai-cli/providers.json`；首次使用時可從
  OpenCode `auth.json` 一次性遷移 API key。direct-api 會輸出 NDJSON streaming events、
  支援 `[image:path]` vision content，並把對話保存到 `workFolder/.tmp/api_sessions/`。（@codex）

### 修正
- **Codex 額度查詢完全失準修復**：`query_usage` 的 codex 一直回傳垃圾值（`percentUsed:100`、`numbers:[1,2,1,2]`）。
  根因有二：(1) 原本沿用通用 `PtyUsageProvider`，固定 1500ms 送 `/status`、6500ms 就 kill；但 codex 啟動會
  boot MCP servers，model 框先閃現真實模型再退回 `loading`，數秒後才穩定，導致 `/status` 被吃掉、面板根本來不及
  渲染就被砍。(2) `parseCodexUsage` 只做寬鬆數字擷取，未解析「5h limit / Weekly limit」面板，也沒處理 codex 的
  **`% left`（剩餘）語意**。改法：新增專屬 `CodexUsageProvider`，以輸出靜止（quiescence）偵測就緒後才送 `/status`、
  面板未出現時依「距上次送出」重試、面板出現後等輸出靜止再擷取，逾時上限放寬至 60s；`parseCodexUsage` 改為結構化解析
  `account/plan/model` 與 `fiveHour/weekly` 的 `{percentRemaining, percentUsed, basis, resetAt}`，同時相容新版
  `% left` 與舊版 `% used`、窄終端 reset 換行、`0% left` 與無方案括號等邊界。另把 settle 的 kill 強化為 Windows
  tree-kill（`taskkill /T /F`），避免 codex fork 出的 MCP server 子程序殘留為 orphan。實測端到端約 7 秒拿到正確
  數據（5h/weekly 剩餘百分比與 reset 時間）。（@claude-code 主導；格式邊界由 @codex-gpt-5.5 提供、程式碼由
  @gemini-3.1-pro 與 @kiro 獨立審查，moerasermax 指示）

### 新增
- **熔斷器 rate 路徑回歸測試**：新增純邏輯測試腳本 `verify-rate.mjs`，注入固定時鐘餵 33 個不同
  prompt 給已編譯的 `CircuitBreaker`，斷言爆量 rate 門檻（`maxStarts=30`）在第 31 次觸發；
  不啟動任何 AI 子程序，與既有 `verify-breaker.mjs`（測 duplicate 路徑）同性質、互補覆蓋兩條電路。
  此腳本曾協助定位「磁碟 dist 已重編但運行中 server 仍載入過期 in-memory build」的問題。（@claude-code，moerasermax 指示）
- **`test` npm script**：`package.json` 新增 `"test": "node verify-breaker.mjs && node verify-rate.mjs"`，
  把兩支純邏輯測試串成正式測試入口，供本地與 CI 快速防回歸（任一支失敗即中止並回傳非零碼）。（@claude-code，moerasermax 指示）

## [3.1.0] - 2026-05-31

### 新增
- **AI 啟動熔斷器（circuit breaker）**：新增 `src/core/circuit-breaker.ts`，在啟動子程序前偵測
  框架無窮迴圈的兩種特徵——「滑動視窗內爆量啟動（rate）」與「重複送出同一 agent + prompt
  （duplicate）」。觸發後開路冷卻、擋下新啟動並回傳清楚錯誤，冷卻結束自動恢復。目的是避免框架
  bug 造成對 AI 供應商的異常流量，被誤判為共用帳號或濫用而違規。門檻全可由 `AI_CLI_BREAKER_*`
  環境變數調整，預設保守。已接入 `ProcessService`（MCP 路徑）與 `FileProcessService`（CLI 路徑），
  並在 `app/mcp.ts` 的 `run` 工具回傳專屬錯誤訊息。附驗證腳本 `verify-breaker.mjs`。（@moerasermax）
- **`query_usage` MCP 工具**：查詢各 AI CLI（Kiro / Claude / Codex / Antigravity）剩餘額度，
  結果快取 120 秒，可用 `refresh=true` 強制更新；新增 `src/plugins/usage-service.ts`。（@moerasermax）
- **共同維護準則**：新增 `CONTRIBUTING.md` 與本 `CHANGELOG.md`，確立「誰改了什麼要留紀錄」的流程。（@moerasermax）

### 修正
- **claude 長中文 prompt 被截斷**：`src/agents/claude.ts` 將 prompt 從命令列參數 `-p <prompt>`
  改為走 stdin（保留 `-p` 旗標）。Windows 下 claude 是 npm `.CMD` shim，spawn 需 `shell:true`，
  cmd.exe 會對含空白/換行/全形標點的長 prompt 重新切詞並在換行處截斷；比照 codex 走 stdin 即可繞過。（@moerasermax）

## [3.0.0] - 2026-05-30（既有基準）

### 新增
- 自有可控的 ai-cli-mcp 框架，採 registry-based 架構：新增 AI agent 只需新增一個檔案。
  支援 Claude / Codex / Antigravity(agy) / Kiro / Forge / OpenCode，背景 job 管理，
  MCP 與 CLI 雙路徑。

### 修正
- Windows 上優先解析 `.cmd`/`.exe` 而非 extensionless shim。
- 移除已壞掉的 gemini 殘留；usage 外掛路徑改由 `AI_CLI_USAGE_PLUGIN_BIN` 環境變數設定。

[Unreleased]: https://example.invalid/compare/v3.1.0...HEAD
[3.1.0]: https://example.invalid/compare/v3.0.0...v3.1.0
[3.0.0]: https://example.invalid/releases/tag/v3.0.0
