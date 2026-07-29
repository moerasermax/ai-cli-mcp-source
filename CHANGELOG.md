# 變更紀錄（Changelog）

本檔記錄所有對使用者/協作者可見的改動。格式參考
[Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循
[語意化版本](https://semver.org/lang/zh-TW/)。每筆結尾以括號標註作者。

維護規則見 [CONTRIBUTING.md](./CONTRIBUTING.md)：**每次改動都要在此補一行。**

## [Unreleased]

## [4.0.0] - 2026-07-29

> **破壞性變更**：移除 OpenCode agent 與 `oc-*` model routing。依 CONTRIBUTING §4，
> 「對外 MCP 行為或介面不相容」屬 MAJOR，因此本版是 4.0.0 而非 3.2.0。
> 仍在用 `oc-<model>` 的呼叫端要改用 direct-api 的 `or-<model>` / `ds-<model>` /
> `<provider>-<model>`。

### 新增
- **model alias 可在 runtime 重新指向，免 rebuild、免重啟**：`config.json` 新增 `aliasModel` 欄位
  （例如 `{"codex-ultra": "gpt-5.6-terra"}`），優先於 `models/catalog.ts` 寫死的 `MODEL_ALIASES`。
  `resolveModelAlias()` 是每次組指令時才呼叫、設定檔又是每次重讀，所以改完下一次 `run` 立即生效。
  同時新增 MCP 工具 **`set_config`** 負責寫入（`alias_model` / `alias_reasoning_effort` /
  `default_reasoning_effort` / `unset`），回傳與 `models` 相同的 payload 讓呼叫端立刻看到生效狀態。
  寫入採「讀原始 JSON → patch → tmp + rename」，會保留設定檔中它不認識的欄位。
  驗證上刻意擋掉未知 model：claude agent 的 `matchesModel` 是 catch-all，不擋的話打錯字會被
  **靜默送去 claude**，因此 `set_config` 只接受某個非 fallback agent 認得的 model 或
  direct-api 的 provider-prefixed 名稱。`models` 的 aliases 每筆新增 `source`
  （builtin/config），被 config 重指的那幾筆另附 `builtinResolvesTo`，
  且 `agent` 欄位改為依實際生效的 model 動態推算
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
- **alias 熱切換回歸測試 `verify-alias-config.mjs`**：33 項斷言，涵蓋 `isKnownModelTarget` /
  `resolveModelAlias` 的邊界（含上述稽核抓出的四個案例）、「同一個 process 內改設定，
  `buildCliCommand` 組出的 `--model` 與 agent 立即跟著變」，以及真的起一個 MCP server
  走 stdio JSON-RPC 驗 `set_config` 的驗證／寫入／`unset`（含「同時清掉 reasoning 覆寫」）／
  未知欄位保留。執行前備份 `config.json`，並以 `try/finally` 無條件還原。（Claude）
- **使用者持久化設定 `config.json`**：新增 `~/.local/share/ai-cli/config.json`（與 providers.json
  同層），支援 `defaultReasoningEffort` 與 `aliasReasoningEffort`，可持久覆寫原本寫死的
  ultra alias 預設（`claude-ultra`=max / `codex-ultra`=xhigh）。優先序為：呼叫端明確參數 >
  `AI_CLI_DEFAULT_REASONING_EFFORT` 環境變數 > `aliasReasoningEffort` > `defaultReasoningEffort` >
  內建預設。設定檔缺失／格式錯誤一律靜默退回內建值；由設定推導出的預設若該 agent 不支援
  reasoning 或值不在其允許集合，會靜默略過而非丟錯（明確傳入的不合法值仍照舊丟錯）。
  設定檔每次重讀，改檔免重啟。`models` 工具新增 `userConfig` 欄位回報目前生效設定。（Claude）
- **direct-api 的 tool use agent loop**：direct-api 不再只是單次問答，內建
  `read` / `write` / `grep` / `glob` / `bash` / `list_dir` 六個工具的 agent 迴圈，
  讓沒有自家 CLI 的 vendor 模型也能真的動檔案與跑指令。（@codex）
- **gpt-5.6 模型家族**：codex catalog 新增 `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`。（@codex）
- **direct-api agent**：移除 OpenCode CLI agent，新增不啟動子程序的 OpenAI-compatible API agent。
  支援 `or-<model>`（OpenRouter）、`ds-<model>`（DashScope）與 providers.json 中的
  `<provider>-<model>`，設定檔位於 `~/.local/share/ai-cli/providers.json`；首次使用時可從
  OpenCode `auth.json` 一次性遷移 API key。direct-api 會輸出 NDJSON streaming events、
  支援 `[image:path]` vision content，並把對話保存到 `workFolder/.tmp/api_sessions/`。（@codex）
- **熔斷器 rate 路徑回歸測試**：新增純邏輯測試腳本 `verify-rate.mjs`，注入固定時鐘餵 33 個不同
  prompt 給已編譯的 `CircuitBreaker`，斷言爆量 rate 門檻（`maxStarts=30`）在第 31 次觸發；
  不啟動任何 AI 子程序，與既有 `verify-breaker.mjs`（測 duplicate 路徑）同性質、互補覆蓋兩條電路。
  此腳本曾協助定位「磁碟 dist 已重編但運行中 server 仍載入過期 in-memory build」的問題。（@claude-code，moerasermax 指示）
- **`test` npm script**：`package.json` 新增 `test`，把純驗證腳本串成正式測試入口，供本地與 CI
  快速防回歸（任一支失敗即中止並回傳非零碼）。本版收斂為四支：`verify-breaker` /
  `verify-rate` / `verify-direct-api` / `verify-alias-config`，全部不打真實 AI 供應商。
  其中 `verify-alias-config.mjs` 會暫時改寫真實的 `~/.local/share/ai-cli/config.json`
  （自帶備份還原），已在 `CONTRIBUTING.md` 標註；`verify-e2e.mjs` 會真的呼叫三家 CLI、
  消耗額度，刻意不納入。（@claude-code，moerasermax 指示）
- **README 新增「alias 重新指向」章節**：補上內建 alias 對照表、`config.json` 的 `aliasModel`
  與 `set_config` 用法、「為什麼免 rebuild 免重啟」的原因、驗證為何從嚴（catch-all 的
  `matchesModel` 會靜默吃掉打錯的 model），以及 antigravity 不吃 `--model`、模型自報名稱
  不可信這兩個已知限制。（Claude）

### 變更
- **ultra alias 的預設指向**：`codex-ultra` 由 `gpt-5.5` 改為 `gpt-5.6-sol`；
  `agy-ultra` / `antigravity-ultra` 由 `agy-default` 改為 `Gemini 3.1 Pro (High)`。
  後者僅影響 `models` 的回報 —— agy CLI 不接受 `--model`，實際模型仍由登入帳號的
  Google AI tier 決定。（Claude，moerasermax 指示）

### 移除
- **OpenCode agent 與 `oc-*` model routing（破壞性）**：`src/agents/opencode.ts` 連同
  `OPENCODE_CLI_NAME` 環境變數與 `oc-` 前綴路由一併移除，改由 direct-api 直接打 vendor API。
  動機是 OpenCode 在大 context 累積後會出現 Qwen tool call 的 doom loop。
  對外影響：原本傳 `oc-<model>` 的呼叫端會失敗（該名稱不再被任何非 fallback agent 認得）。（@codex）
- **`verify-equivalence.mjs`**：它比對的是「新 dist vs 舊 `ai-cli-mcp-patched/` 的 dist」，
  而該路徑早已不存在，任何人跑它都必定 `ERR_MODULE_NOT_FOUND`。等價性驗證的階段性任務已結束，
  留著只會讓「跑一輪全部 `verify-*`」的人踩雷。（Claude）

### 修正
- **`set_config` 的 `__proto__` 與空 map 會靜默假成功**：`readStringMap` 用普通 `{}` 收結果，
  `out['__proto__'] = '<字串>'` 會打到 `Object.prototype` 的 setter 並被無聲丟棄，
  該 key 根本不會成為 own property → 後面的 alias 驗證迴圈掃不到 → 呼叫端拿到「成功」
  但什麼都沒設定。同理 `alias_model: {}` 也能通過「Nothing to change」檢查後空跑一趟。
  改為以 `Object.create(null)` 收集（`__proto__` 會變成正常的 own property 而被 alias 驗證擋下），
  並明確拒絕空 map。這是先前 prototype key 稽核（改用 `hasOwnProperty`）漏掉的同族案例。（Claude）
- **`verify-rate.mjs` 失敗時不會回傳非零 exit code**：它只印一行 `UNEXPECTED` 就正常結束，
  被 `&&` 串在 `npm test` 裡等於 rate 邏輯回歸也測不出來（CHANGELOG 3.1.0 對這支腳本
  「任一支失敗即中止」的描述因此並不成立）。改為失敗時設 `process.exitCode = 1`。（Claude）
- **`npm test` 可能測到過期的 `dist`**：測試載入的是 `dist/`，但 `test` script 不會先編譯，
  只改 `src` 的話會測到舊 build（而 `dist/` 被 gitignore，乾淨 clone 則直接缺模組）。
  新增 `pretest: npm run build`。（Claude）
- **`verify-alias-config.mjs` 的設定檔還原不夠可靠**：還原只寫在正常流程末端，
  任何例外（import / spawn / JSON parse 失敗）都會讓使用者的 `config.json` 停在測試中途狀態；
  原本沒有 `config.json` 的機器跑完會被留下一份測試產物；父目錄不存在時會 `ENOENT`。
  改為 `try/finally` 無條件還原、原檔不存在就刪掉、寫入前建父目錄。
  另把端到端那段改成不沿用使用者的 `baseConfig`，斷言才不會被使用者自己的
  `defaultReasoningEffort` 影響。（Claude）
- **`verify-mcp.mjs` 只檢查 9 個工具**：漏掉 `set_config` 與 `query_usage`，
  輸出還寫死「all 9」。改為檢查全部 11 個。（Claude）
- **`package-lock.json` 的版本停在 3.0.0**：與 `package.json` 不一致，一併同步。（Claude）
- **設定檔快取會漏掉「同一毫秒內的第二次寫入」**：`loadUserConfig()` 原本用 mtime 當快取鍵，
  但 mtime 的解析度不足以區分同一毫秒內的兩次寫入 —— 先讀一次（快取住 mtime M）→ 同一毫秒內
  檔案被改寫（新 mtime 仍是 M）→ 之後會**一路回傳過期設定**，直到有人再動一次這個檔。
  `updateUserConfig()` 只作廢自己這個 process 的快取，擋不到別的 process 或使用者手動編輯。
  改為每次讀檔、以**檔案內容**當快取鍵（設定檔只有幾百 bytes，快取存在的意義只剩省下 JSON 解析）。
  發現經過：把 `verify-alias-config.mjs` 納入 `npm test` 後，它從單獨跑必過變成在測試串裡穩定失敗
  3 項 —— 前面的腳本讓 node 暖機，兩次寫入因此落在同一毫秒。回歸測試用 `utimesSync` 把兩次寫入的
  mtime 直接鎖成同一個值，讓這個競態變成必然而非碰運氣。（Claude）
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
- **Qwen tool call 相容性**：direct-api 新增 XML 格式 tool call 的 fallback 解析器，
  處理 Qwen 不照 OpenAI JSON tool call 格式輸出的情況。（@codex）
- **Windows `cmd.exe /s /c` 外層引號**：含空白的 prompt 在 MCP 路徑會被 cmd.exe 重新切詞，
  改為明確的 `/d /s /c` 加引號包裝。（@codex）
- **Windows detached wrapper 的 `shell:true`**：CLI detached 路徑下，含斜線的 model 參數
  （當時的 `oc-*`）會被 shell 重新解讀而壞掉。（@codex）

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

[Unreleased]: https://example.invalid/compare/v4.0.0...HEAD
[4.0.0]: https://example.invalid/compare/v3.1.0...v4.0.0
[3.1.0]: https://example.invalid/compare/v3.0.0...v3.1.0
[3.0.0]: https://example.invalid/releases/tag/v3.0.0
