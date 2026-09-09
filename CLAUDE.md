# CLAUDE.md — 這棵樹的現況與紅線

給在這個 repo 上工作的 AI agent。**動手前讀完這頁。**

協作流程（commit 格式、CHANGELOG 規則、突變測試、core 改動的稽核義務）在
[CONTRIBUTING.md](./CONTRIBUTING.md)，這裡不重複。這頁只寫**你不會自己發現、
而弄錯會造成對外傷害**的現況與禁止事項。

---

## 這是什麼

一個 MCP server：把本機裝的 AI CLI（claude / codex / antigravity）與任何
OpenAI-compatible API 包成**背景工作**。`run` 立刻回 PID，呼叫端用
`list_processes` / `peek` / `wait` / `get_result` 觀察，而不是阻塞等待。

**這是 fork，不是原創作品。** 上游是 mkXultra/ai-cli-mcp（MIT），再上游是
Peter Steinberger 的 claude-code-mcp（MIT）。分歧點在架構：上游把後端寫死，
這裡 `src/agents/` 一個 CLI 一支檔案，是唯一的擴充點——**加後端不該動
`src/core/`**。

---

## 現況（2026-09-09 之後）

| 項目 | 值 |
| --- | --- |
| GitHub | `moerasermax/tkflyc-ai-cli` — **2026-09-09 改名**，舊名是 `ai-cli-mcp` |
| npm | `@tkflyc/ai-cli-mcp` — **已公開發佈** |
| 版本 | `6.1.1` |
| 授權 | **Apache-2.0** — 2026-09-09 從 MIT 改的，附 `NOTICE` |
| 主分支 | `master`（push 到 master 等同部署，所有機器會自動拉） |
| CI | Windows / Linux / macOS × Node 20.19、22 — **三個平台都是閘門** |
| 本機路徑 | `C:\Users\Moera\ai-cli-mcp-source`（目錄名還是舊的，不影響任何東西） |

規模：`src/` 32 個 `.ts`、9,423 行；10 支 `verify-*.mjs` 進 `npm test`
（`verify-e2e.mjs` 會真的燒額度，刻意不進）。

---

## 紅線

### 1. `NOTICE` 不可刪，也不可移出 `package.json` 的 `files`

它帶著兩位上游作者的著作權聲明、保留的 MIT 條款，以及實測數字：
**1,980 行實質原始碼裡有 299 行（約 15%）與上游相同**，集中在 MCP 工具面與
CLI/MCP 入口。放在 repo 裡不算數——`files` 沒列它，它就不會隨 npm 套件散布，
歸屬聲明等於沒做。

### 2. 不要寫「上游已停止更新」

**上游活著。** 實測：npm `2.23.0` 發於 2026-09-06、GitHub 最後推送 2026-09-07、
25 stars、週下載約 680 次。這句話 2026-09-09 曾被寫進 README（中英）、CHANGELOG
與兩篇 Release notes，全部是錯的，已更正。

它糟在**驗證成本極低**——任何人點進上游 repo 三十秒就會看到——所以同時毀掉
可信度和歸屬聲明的誠意。要寫上游狀態就去查，不要從「我沒在追蹤它」推論。

### 3. POSIX CI 是閘門，不是實驗

`test-posix` 2026-09-09 從 `continue-on-error` 升為閘門。**不要為了讓它過而
把它降回實驗性。** 它紅了就是真的回歸。

順帶記住 `continue-on-error: true` 放在 **job 層**時，不管步驟怎麼失敗、
job 的 conclusion 都是 `success`——看 CI 綠不綠要看**步驟層**的結論。

### 4. 發版：先 `npm version` 打 tag，再 build，再 publish

npm 上的 `6.0.0` 是從**比 tag `v6.0.0` 多 13 個 commit** 的工作樹發出去的，
provenance 對不上。那個版本已 `deprecate`，**不要拿它當任何基準**。
已推出去的 tag 沒有重寫，歷史就留著。

另外 `npm version` 打的是 **annotated tag**：`git rev-parse v6.1.1` 給你的是
tag 物件的 SHA，要 commit 得用 `v6.1.1^{}`。

### 5. `process.exit()` 之前要排空 stdout

`src/bin/ai-cli.ts` 有 `exitAfterFlush()`，新增子命令請用它。
理由：stdout 是 pipe 時寫入是非同步的，直接 `process.exit()` 會在緩衝區還有
資料時就結束行程。macOS 的 pipe buffer 是 8 KiB，而 `models` 的 payload 實測
12,478 bytes——呼叫端拿到在第 8192 位元組被切斷的 JSON，不報錯、不留痕跡。

**「一次性輸出」不等於「小」。** 這個 bug 的正確註解早就寫在那裡，只是適用
範圍判斷錯了。

### 6. 對外文件不要造假社群訊號

star、fork、下載量、貢獻者數字一律據實。沒有就寫沒有。

---

## 更早的脈絡在哪

- 知識庫 namespace **`ai-cli-mcp`**（`mcp__knowledge__knowledge_search`）——
  架構、模型清單、direct-api、歷次假綠燈的根因。
- 通用的 npm 發佈／GitHub 整備／衍生專案授權經驗在 **`_global`** 資料層。
- 逐次改動的理由在 `CHANGELOG.md`：每一筆都寫了**為什麼**，不是只寫改了什麼。
