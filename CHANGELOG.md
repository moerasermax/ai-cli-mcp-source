# 變更紀錄（Changelog）

本檔記錄所有對使用者/協作者可見的改動。格式參考
[Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循
[語意化版本](https://semver.org/lang/zh-TW/)。每筆結尾以括號標註作者。

維護規則見 [CONTRIBUTING.md](./CONTRIBUTING.md)：**每次改動都要在此補一行。**

## [Unreleased]

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
