# 變更紀錄（Changelog）

本檔記錄所有對使用者/協作者可見的改動。格式參考
[Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循
[語意化版本](https://semver.org/lang/zh-TW/)。每筆結尾以括號標註作者。

維護規則見 [CONTRIBUTING.md](./CONTRIBUTING.md)：**每次改動都要在此補一行。**

## [Unreleased]

## [6.0.0] - 2026-09-08

**判 MAJOR 的理由是對外行為不相容，不是這一版做了多少東西。** 依 CONTRIBUTING §4，
下列每一條各自都足以構成 MAJOR：

| 變更 | 舊行為 | 新行為 | 誰會壞 |
|---|---|---|---|
| `wait` 逾時 | 丟錯（MCP InternalError） | 回目前結果陣列，running 的帶 `timedOut: true` | 靠 `catch` 判斷逾時的呼叫端 |
| `codex-ultra` | → `gpt-5.6-sol`、effort `xhigh` | → `gpt-6-astra`、effort `max` | codex-cli < 0.153 的機器會被 API 拒絕 |
| `doctor.checks.loginState` / `termsAcceptance` | `boolean` | `null`（誠實表示「沒驗這個」） | 把它當布林讀的呼叫端 |
| CLI job 無結束紀錄時 | `failed` | `lost`（不知道 ≠ 失敗） | 只判斷 `failed` 的呼叫端會漏掉 |
| `gemini-*` 模型名 | 由 claude 的 catch-all 接走 | 路由到 agy，並實際傳 `--model` | 依賴舊路由行為的呼叫端 |

前兩條是 2026-09-05 那批，後三條來自 `805c619`（2026-08-22）——**是發版前逐 commit
對照才補上的**，我原本只記得自己近期做的那兩條。這正是 CONTRIBUTING §4 要求
「照 git log 逐 commit 對照，不能只看自己記得的部分」的理由（4.0.0 也踩過同一個坑）。

這一版的主線是**讓工具對呼叫端說實話**：`wait` 逾時回 liveness 而不是錯誤、模型目錄
說得出每一筆的出處與能不能派工、`run` 的回傳說得出「這次改了程式碼但沒驗證」。
另外補上原始碼安裝的自動更新，以及一個會擋住自己的程式碼修改驗證閘門——
它上線當天連續四次擋錯人，那四次的修復也在下面。

### 新增（程式碼修改驗證閘門）

> **這一批標記為實驗性。** 判定是啟發式的，上線第一天就誤擋七次（單字母副檔名、`->`、
> `2>/dev/null`、引號裡的重導向、`rg "npm test"` 誤判通過、`FAIL=0`），全部修掉了，
> 但這代表判定規則還在收斂。三次誤擋的修法都**刻意選擇收緊**（寧可漏擋不要誤擋），
> 所以實際覆蓋率低於設計覆蓋率——`cmd>file` 不留空白、單字母副檔名沒路徑都會漏。
> `run` / `wait` / `get_result` 多回一個 `verification` 欄位是加法、不影響既有呼叫端；
> 會擋人的那一層是**要自己去 `/plugin install` 才會生效**的，預設不啟用。

- 新增 `src/core/verification.ts`：程式碼修改的驗證狀態五態判定（`not_applicable` / `not_observed` / `passed` / `failed` / `waived`，running 另回 `pending`）。**刻意不是布林值**——`verified: false` 沒辦法區分「沒改程式碼所以不用驗」「改了但看不到有沒有驗」「驗了而且失敗」這三件對呼叫端意義完全不同的事。判定依**事件順序**：驗證必須發生在最後一次修改之後，否則「先跑測試再改程式碼」會假通過。（Claude，moerasermax 指示）
- `run` / `wait` / `get_result` 的回傳新增 `verification` 欄位，**compact 模式也不拿掉**。呼叫端是 AI，它只看得到工具回傳；回傳沒說「這次改了程式碼但沒驗證」，它就會把子 agent 的「我做完了」當成做完了。這與 2026-09-05「wait 逾時不丟錯、改回 liveness」同源：工具要對 AI 說實話。antigravity 沒有結構化工具紀錄，一律回 `not_observed`（看不到不等於沒改），不得回 `not_applicable`。（Claude，moerasermax 指示）
- 新增隨附的 Claude Code plugin `ai-cli-verification-gate`（`plugin/`，附 `.claude-plugin/marketplace.json`）：Stop hook 在「本回合改了程式碼卻沒跑驗證」時擋一次，要求補驗證或寫明豁免理由。硬性規則為一律 exit 0、最多擋一次（靠官方 `stop_hook_active` 防無限迴圈，第二次一律放行並誠實記下原狀態、標 `gate: allow-after-block`）、無法可靠判定時不擋。與第 1 層共用同一個判定模組，不是另一套規則。（Claude，moerasermax 指示）
- 新增 `verify-verification.mjs`（100 條）與 `verify-gate-hook.mjs`（47 條）並納入 `npm test`；新增 46 個突變（39 個判定、記錄、plugin 偵測與稽核修復，7 個 hook），涵蓋順序陷阱、compact 拿掉 verification、running 假稱結果、agy 誤判、豁免蓋過失敗、exit_code 被輸出文字蓋過。hook 的狀態目錄沿用 `AI_CLI_STATE_DIR` 隔離，測試不碰使用者目錄。（Claude，moerasermax 指示）
- 動機是實測而非臆測：掃 2026-09-06 13:00 起 44 小時、178 條 Claude Code transcript、26,003 筆 usage 記錄後，有改到程式碼的工作段裡 **31.7% 完全沒跑任何 test/build**，且該比例隨上下文長度上升（峰值 0-200k 為 5%、600-800k 為 59%）；有驗證的工作段返工率 59.2%、平均 4.67 圈。同一份資料顯示首次驗證通過率在各上下文區間之間沒有趨勢（89/77/86/78/86%），亦即長上下文並未讓品質變差，只是同一件工作在 800k+ 要花 11.64M 額度、在 200k 以下只要 1.43M。（Claude，moerasermax 指示）
- 判定加上專案範圍：只有工作目錄底下的修改才算數（ai-cli 傳 `workFolder`、plugin 傳 hook 事件的 `cwd`）。這是拿真實 transcript 實測時抓到的誤報——寫在暫存目錄的一次性分析腳本被當成專案程式碼而要求驗證，但那種腳本本來就沒有測試可跑。相對路徑一律算在專案內（它本來就相對於工作目錄解析）。（Claude，moerasermax 指示）
- 新增 `src/core/verification-log.ts`：第 1 層的判定結果落地到 `AI_CLI_STATE_DIR/verification-gate.jsonl`，**與 plugin 的 Stop hook 寫同一份檔案**，用 `source`（`ai-cli` / `hook`）區分。兩層合起來才是一台機器完整的品質基線，分開存會變成兩份誰也代表不了整體的數字。同一個 pid 只記一次（`wait` 會反覆呼叫 `getProcessResult`）。這一層只記錄、不彙總、不外送——跨機器基線需要明確的同步端與隱私政策，在那之前資料留在本機。（Claude，moerasermax 指示）
- 新增已安裝 plugin 的**過時偵測**：`doctor.plugin` 多一個 `upToDate`，直接比對已安裝的判定核心與這份 repo 的內容（版本號靠不住——改邏輯不一定會 bump version）。**plugin 安裝之後不會跟著 repo 更新**：Claude Code 把 source 目錄複製到 `~/.claude/plugins/cache/`，之後 `git pull` 再怎麼前進，cache 裡那份都不會動。2026-09-08 實測踩到：閘門連修兩次誤判、都 push 了，本機仍用舊判定擋人，而且完全沒有跡象。過時時提示重裝指令；讀不到 installPath 回 `null` 而非 `false`——比對不了不是過時，不該因此催人重裝。（Claude，moerasermax 指示）
- 新增 `src/core/plugin-status.ts` 與 `doctor.plugin`／`run.pluginNotice`：ai-cli 自己偵測「plugin 檔案在、但這台機器的 Claude Code 沒啟用」並提醒，**每 3 天最多一次**（`AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC` 可覆寫，`AI_CLI_CLAUDE_SETTINGS_PATH` 供測試隔離）。自動更新只散布程式碼、不散布啟用狀態——plugin 的檔案會跟著 pull 到每台機器，但要不要載入記在各機器自己的 `settings.json`，而 ai-cli 不去改那個檔。只提醒一次不夠（新機器第一次跳出來時多半在忙，錯過就永遠看不到），每次 run 都喊又太吵，所以取 3 天。真的啟用後清旗標，日後若停用會重新開始提醒；讀不到或無法解析 `settings.json` 時只填 `reason`、不提醒——那可能根本不是 Claude Code 環境。（Claude，moerasermax 指示）
- **第四輪稽核（@codex-gpt-5.6-sol high 讀實作原始碼）找到 7 個成立的問題，全部修復**，其中兩個會讓閘門實際失效：
  - **plugin 從 marketplace 安裝後永久靜默失效**：hook 原本 import `../../dist/core/verification.js`，但 `dist/` 不進版控（實測 `git ls-files dist` 為 0），正式安裝的機器上必然找不到，而「找不到就放行」的設計讓它不留任何痕跡地失效。改為 plugin 自帶 `plugin/hooks/verification-core.mjs`，由 `npm run build` 經 `tools/sync-plugin-core.mjs` 從單一來源同步並進版控，測試斷言兩者一致，改了 src 忘了 build 會被 `npm test` 擋下。
  - **`0 failed` 被判成失敗**：`49 passed, 0 failed` 是最常見的成功輸出，舊的失敗比對認裸的 `failed`，實測會誤判。改成只認「非零個失敗」與明確失敗標記，並加 `all tests passed` 這類零失敗說法的白名單。
  - **同一指令同時改檔與驗證時，那次修改憑空消失**（`sed -i src/a.ts && npm test`）：舊版先認驗證就回傳，後續若再有一次驗證會整體判成 `passed`。改為改檔優先判定——無法確知先後就保守當成未驗證。
  - **`echo "npm test"` 被當成跑過驗證**：最廉價的偽造方式，現在 echo/printf/cat 開頭一律不算驗證。
  - **路徑 `..` 未解析**：`../outside/evil.ts` 與 `C:\proj\..\outside\evil.ts` 都會被當成專案內。`canonical` 改為真的解析 `.`／`..`，相對路徑接到 projectRoot 上再判斷，且只在 win32 折疊大小寫（POSIX 檔案系統大小寫敏感）。
  - **shell 改檔不受 projectRoot 限制**：改專案外的檔案也會要求本專案跑測試。現在從指令抽出路徑 token 逐一判斷。
  - **第七態「verification 欄位缺席」**：`verificationFromAgentOutput` 在「有記錄能力但這次沒有 tools」時回 `null`，與「一律回報」的契約矛盾。改為一律回報 `not_applicable`。
  - 另修 `verification-log` 的去重標記早於實際寫入（首次寫失敗就永不重試）、hook 在第二次放行時謊稱 `waived`（waived 依定義需要明確理由，hook 無法可靠判斷，改為誠實記錄原狀態並標 `gate: allow-after-block`）、`process.exit` 可能截斷 stdout。**並採納其設計意見：驗證失敗也擋一次**——原本只擋「沒驗證」，但模型看得到測試失敗仍可能回一句「改好了」就結束，那正是完成閘門要防的事。（Claude，moerasermax 指示）
- **端到端實測抓到 codex 改檔完全看不到**：codex 用 `file_change` item type 記錄改檔，而 `agents/codex.ts` 的 parser 只收 `mcp_tool_call` 與 `command_execution`，因此 codex 子 agent 改了程式碼也永遠判 `not_applicable`——第 1 層對 codex 等於失效。parser 補收 `file_change` 並把多檔展開成每檔一筆。真實派工複驗：改檔不驗證判 `not_observed`、改檔並跑 `npm test` 判 `passed`。（Claude，moerasermax 指示）
- 這批由 Claude 實作、@codex-gpt-5.6-sol（high）分三輪獨立稽核並修正三個實錯：兩張統計表口徑不一致（效率差距 8.3 倍實為 2.7 倍）、首次通過率母體混入未改程式碼的工作段（91.4% 實為 81.7%）、`205:1965` 是不同單位不能當覆蓋率。設計上採納其三項意見：五態而非布林、驗證須在最後一次修改之後、以 companion plugin 散布而非改寫使用者的 `~/.claude/settings.json`。（Claude，moerasermax 指示）

### 修正（發版前稽核抓到的第三類誤判：「說到」被當成「做到」）
- **修正假通過**：改完程式碼之後只要指令**字面上**出現 `npm test`，判定就回報 `passed`——`rg "npm test" README.md`、`grep -rn "npm test" .`、`git log --grep="npm test"` 全都算數。**閘門謊報通過比誤擋嚴重得多，因為呼叫端會信它。** 搜尋類指令（rg/grep/ag/ack/findstr/Select-String、`git log --grep`）一律不算跑過驗證；但 `pwsh.exe -Command "npm test"` 仍算——那裡的引號包的是真的要執行的指令，是 codex 在 Windows 的形狀。（Claude，moerasermax 指示）
- **修正引號裡的重導向被當成寫檔**：`echo "example > src/a.ts"`、`echo "用 tee src/x.ts 可以同時看到"` 這種說明文字會被判成改了程式碼。判斷寫檔目標前先剝掉引號內容；`echo "x" > src/gen.ts` 的重導向在引號外，仍然算數。（Claude，moerasermax 指示）
- **修正輸出含 `FAIL=0` 被判成失敗**：大寫 `FAIL` 一律中，而零失敗白名單只認得 `0 failed` 這種語序，接不住 `FAIL=0` / `FAIL: 0` 這類計數器寫法。這個誤判是閘門在我報告它有問題的那一則回覆裡當場示範的。（Claude，moerasermax 指示）
- **修正測試讀 stderr/stdout 時逐 chunk 解碼**：`stderr += buffer` 會對每個 chunk 各自 `toString()`，一個中文字（3 bytes）跨 chunk 邊界時兩邊都解成替換字元，要比對的中文訊息就永遠對不上。這是 `verify-update.mjs` 那支 flaky 的**第二個**來源（第一個是等待條件漏了一半）。`verify-update` / `verify-gate-hook` / `verify-exec-contract` / `verify-alias-config` 都補上 `setEncoding('utf8')`——`verify-liveness` 與 `updater.ts` 本來就有。（Claude，moerasermax 指示）
- **修正 `upToDate` 沒考慮 install marker**：hook 現在會優先讀 marker 指到的安裝，那份就是最新的，這時候 cache 舊不舊都不影響實際行為，催人重裝是騷擾。marker 指向本安裝時直接回 `true`；指向別的安裝時仍比對 cache。（Claude，moerasermax 指示）
- **修正三個突變因為上面的修復而對不上原始碼**：`tools/mutations.json` 的 `from` 片段一旦與原始碼不符，harness 回報 `ERROR`（片段不存在）而不是 `SURVIVED`——那個突變等於沒在測任何東西，但總表看起來仍然沒有 SURVIVED。改為從當前原始碼取出片段、再用 `replace` 推導突變後的樣子，手寫跳脫在 JSON / JS / shell 三層之間必錯。另補三個突變守住這次的修復（搜尋指令算成驗證、不剝引號、`upToDate` 不看 marker），驗證閘門的突變數 43 → 46。（Claude，moerasermax 指示）
- 這五條由 @gpt-6-astra（high，使用者特許）在發版前稽核抓出，逐條實測確認成立後才修。它同時指出版號判定漏了三個破壞性變更、CHANGELOG 漏記六個 commit、以及「第二次記 waived」那句與實作自相矛盾——都已補正。（Claude，moerasermax 指示）

### 修正（驗證閘門上線後的三次誤擋與 plugin 送達問題）
- 修正 `CODE_EXT` 收單字母副檔名 `c|h|m|r` 造成的誤判：Python 的 `re.M`、`re.S` 這種 regex flag，以及任何 `物件.c` 形式的屬性存取，都會被當成程式碼檔案路徑。改為單字母副檔名必須有路徑分隔符才算——`src/main.c` 仍算，`re.M` 不算。（Claude，moerasermax 指示）
- 修正重導向偵測沒要求前綴：輸出訊息裡的 `->`、比較用的 `=>`、regex 字面值裡的 `>` 都會被當成寫檔，一句 `echo "字數: 4591 -> readTime 應為 10"` 就讓整個回合被判成改了程式碼。改為 `>` 必須前接行首、空白、`;&|)` 或 fd 數字；代價是 `cmd>file` 這種不留空白的寫法會漏掉——漏擋比誤擋便宜。（Claude，moerasermax 指示）
- 修正「有寫檔動作」與「有程式碼路徑」被分開判定：那兩件事可能毫無關係——`grep -rn "a" src/core/updater.ts 2>/dev/null` 的寫入目標是 `/dev/null`，跟那個 `.ts` 無關，卻因為兩個條件各自成立而被判成改了它。改為只看**實際寫入的目標**（重導向取 `>` 後面那個 token，`tee`／`mv`／`cp` 取目的地，`dd of=`／`install -D` 取參數，`sed -i`／`patch` 因目標位置不固定才退回掃整串）。順帶修正 `cp src/a.ts /tmp/backup.txt`——來源是程式碼，但寫入目標不是。舊的 `SHELL_WRITE` 與 `pathTokens` 一併移除。（Claude，moerasermax 指示）
- 修正 plugin 安裝偵測只讀 `settings.json`：本機實查有 4 個 project scope 的 plugin 是 `enabledPlugins` 完全看不到的，於是裝過的機器會被判成沒裝而每 3 天被催一次。改為 `installed_plugins.json` / `known_marketplaces.json` / `settings.json` 三個來源任一說有就算有，三個全部讀不到才算判斷不了；狀態多回一個 `scopes`。（Claude，moerasermax 指示）

### 新增（plugin 自動跟上 ai-cli）
- 新增 `src/core/install-marker.ts`：MCP server 啟動時把自己的 repo 根寫進 `AI_CLI_STATE_DIR/install.json`，hook 優先讀那份安裝的判定核心、讀不到才用 plugin 自帶的。**Claude Code 安裝 plugin 是把 source 目錄複製到 cache，之後 `git pull` 不會動它**——沒有這條的話，每修一次判定就要重裝一次 plugin，而重裝完又會被下一次修改超車（2026-09-08 實測連續發生四次）。自足是下限、跟上是常態，兩者要一起成立。marker 只放路徑且兩端都驗證：寫的時候確認真的看得到判定核心，讀的時候確認那個路徑下真的有——「指到不存在的地方」跟「沒有 marker」下場相同。（Claude，moerasermax 指示）

### 測試（驗證閘門）
- 修掉四條假綠燈：`async` 函式傳進同步的 `ok()` 時，`fn()` 只回傳 Promise，try/catch 抓不到裡面的斷言錯誤，那四條測試永遠通過（其中一條還是最重要的 plugin 判定核心一致性）。`ok()` 現在明確擋掉 Promise，動態載入一律提到檔案頂層。突變 harness 補上判定核心的同步步驟並在收尾重建產物，`.gitattributes` 釘住產生檔的換行，否則「worktree 應乾淨」每輪誤報。（Claude，moerasermax 指示）
- 移除兩個本質上測不到的突變並在程式碼註明那兩層是冗餘防護：修完「只看寫入目標」之後，重導向的前綴檢查與 `/dev/null` 白名單都殺不掉任何斷言——主要保護擋在後面。留著測不到的突變只會每輪紅一次，但要寫明它們是第二層，免得後人在錯的地方修東西。（Claude，moerasermax 指示）

### 其他（發版前逐 commit 對照補記）
- `exec` 前景執行契約：呼叫端自己擁有程序、自己收 stdout、自己判斷終態，`started` frame 回報實際生效的模式。fail-closed 為預設——agent 沒有 `buildStrictCommand` 就拒絕啟動，不退回帶著 `--dangerously-*` 全開權限的 `buildCommand`。（`805c619`、`0df5c04`）
- `doctor.checks.loginState` 與 `termsAcceptance` 由 `boolean` 改成 `null`：doctor 只驗二進位路徑，從來沒有驗登入狀態，回 `false` 會讓人以為「驗過了、沒登入」。`null` 誠實表示「這一項沒有驗」。**這是破壞性變更**，見上方相容性表。（`805c619`）
- CLI 的 job 在沒收到結束回報時由 `failed` 改成 `lost`：程序不見了而且沒有結束紀錄，結果是**真的不知道**，那跟失敗不是同一件事。**這是破壞性變更**。（`805c619`）
- `gemini-*` 模型名改由 antigravity 認領並實際傳 `--model`：先前會被 claude 的 catch-all 靜默接走。**這是破壞性變更**。（`805c619`）
- 修正 `marketplace.json` 缺 `id`、`plugins[].version` 導致 `/plugin install` **完全沒有輸出、沒有安裝、也沒有錯誤訊息**；補齊必要欄位並加測試守住。（`7c64ae5`）
- 英文 README 改為主入口、中文保留為完整參考；新增 Apache-2.0 授權；`.planner-id` 進版控（跨 checkout 的專案身分標記）；`package-lock.json` 版號補同步，避免安裝後留下髒樹。（`df3386e`、`6372cb7`、`da7010f`、`6912c90`、`e67657b`）

### 新增（ai-cli 自動更新）
- 原始碼安裝新增背景更新器：MCP 連線後延遲檢查 origin，獨立 CLI 子程序以 fast-forward 套用、依套件變動安裝或建置、doctor 煙霧測試；支援 on／check／off、檢查節流、髒樹與分支守門、pid 殘留鎖、失敗回滾和 node-pty 鎖檔說明。（@codex-gpt-6-astra，moerasermax 指示）
- 新增 `ai-cli update [--check] [--json]`、原子寫入的 update.json 與 update.lock、含 SHA／commit 標題／CHANGELOG 網址的持續重啟提示；doctor.update、MCP run.updateNotice、models.updateNotice 及 stderr／MCP warning 通知讓使用者可見，新版啟動才清提示。（@codex-gpt-6-astra，moerasermax 指示）
- 新增暫存 bare origin 與雙 clone 更新驗證、真實 MCP 背景套用與重啟測試，以及回滾／髒樹／節流／非祖先／notice 五個突變；mutation harness 支援按 verify script 篩選。（@codex-gpt-6-astra，moerasermax 指示）

### 變更（測試隔離與部署政策）
- `npm test` 納入 verify-update；既有 server／CLI 驗證明確關閉自動更新，設定、狀態、provider 與目錄快取改用暫存目錄（新增 AI_CLI_CONFIG_DIR），不再改寫真實 config.json，git 網路協定在測試中停用。（@codex-gpt-6-astra，moerasermax 指示）
- README 與 CONTRIBUTING 記載背景套用、下次啟動生效及 public master push 等同全機部署，要求 push 前 npm test 全綠；package.json 新增 CHANGELOG homepage。（@codex-gpt-6-astra，moerasermax 指示）
- 這批自動更新由 @codex-gpt-6-astra（codex-ultra，max）實作、@gemini-3.1-pro 獨立審查（未發現確信問題；
  註記提示清除後每次 CLI 啟動仍會印「已是最新版」——已改成只在真的清掉提示那一次印）；Claude 逐項驗證：
  build 零錯誤、`npm test` 九支全綠（update 45 條）、5 個新突變全部由指定斷言 KILLED。（Claude，moerasermax 指示）

### 修正（agy 模型查詢常態逾時）
- 修正把 `agy models` 誤當本機讀設定的假設：agy 1.1.26 會先做網路 eligibility check，八次暖機實測 1739–3972 ms，舊的 5 秒同步查詢加 60 秒記憶體快取使重連與到期後的 MCP 請求卡住。改成 `spawn` 非同步、有計時與逾時殺子程序樹；同步目錄只讀快取，`tools/list`／`set_config` 不等網路，明確 `models` 才等待；失敗保留成功值並附診斷。（@codex-gpt-6-astra，moerasermax 指示）
- 這批改動由 @codex-gpt-6-astra（codex-ultra，max）實作、@gemini-3.1-pro 獨立審查（未發現確信問題；註記多 process
  同時寫快取時後寫者會蓋掉前者對其他 agent 的新值，目前只有 agy 有快取，先接受）；Claude 逐項驗證：build 零錯誤、
  `npm test` 八支全綠（catalog-source 74、mcp 12、liveness 97）、8 個新突變全部由指定斷言 KILLED。
  根因蒐證：把 proxy 指到不存在的位址時 `agy models` 238 ms 內失敗並印出 loadCodeAssist 的連線錯誤，
  證明它每次都先打網路；`tools/list` 的描述字串每次請求重算，等於每次重連都同步打一次。（Claude，moerasermax 指示）

### 變更（模型目錄出處）
- `AgentDefinition.discoverModels` 改回 Promise，接受模型陣列／null 或 `{ models, note }`；新增 `ModelListSource` 的 `vendor-cli-cached`，與此 process 問到的 `vendor-cli`、靜態 `builtin-fallback` 分開；`catalogV2.agents[]` 新增 `verifiedAt`，既有 payload 與同步 `getModelsPayload()` 簽章保留。（@codex-gpt-6-astra，moerasermax 指示）

### 新增（模型查詢快取與驗證）
- 新增 `CONFIG_DIR/catalog-cache.json`（每 agent 的 models／verifiedAt／cliPath、tmp + rename、同路徑且不超過 30 天才採用），`refreshCatalogV2({ force? })` 的單飛與 10 分鐘新鮮度、`clearCatalogCache({ disk: true })`，以及 `AI_CLI_CATALOG_CACHE_PATH`／`AI_CLI_DISCOVER_TIMEOUT_MS`（預設 15000 ms）覆寫。（@codex-gpt-6-astra，moerasermax 指示）
- 擴充既有 catalog-source 與三入口 MCP 測試；新增慢速／eligibility 錯誤 agy stub、alias 測試與突變 harness 的暫存快取隔離，以及同步阻塞、失敗蓋掉快取、錯報 source、逾時不 kill／不回 null、MCP／CLI 等待規則的突變，維持八支 `npm test` 腳本且不連真實 vendor。（@codex-gpt-6-astra，moerasermax 指示）

### 新增（程序存活資訊）
- MCP 與 CLI 的 running 結果新增統一 `liveness`：存活狀態、啟動與最後輸出秒數、stdout/stderr bytes、事件摘要、事件數與英文等待提示；`list_processes` / `ps` 同時提供時間摘要。Codex 推理期間可能零輸出，等待端需要區分沉默與程序消失，避免把 wait 逾時錯誤當成失敗而遺棄 pid。（@codex-gpt-6-astra，moerasermax 指示）
- `verify-liveness.mjs` 與慢速 Codex stub 納入 `npm test`，覆蓋兩條路徑、跨 CLI 行程、消失程序的 false/lost 對照與突變測試，確保「逾時不是失敗」及存活提示真的受到斷言保護。（@codex-gpt-6-astra，moerasermax 指示）
- 這批 liveness 改動由 @codex-gpt-6-astra（codex-ultra，max）實作、@gemini-3.1-pro 獨立審查（未發現確信問題）；
  Claude 逐項驗證：build 零錯誤、`npm test` 全綠（liveness 97 條）、6 個新突變加上既有第 16 案共 7 個全部 KILLED。
  起因是實際踩到：透過 `wait` 等 codex-ultra 實作時，每 100 秒就收到一次「Timed out」錯誤，而 codex 其實還在跑。
  實測 codex 慢的主因是模型端推理（trivial 回答 5–7 秒，高 effort 可達數分鐘），載入使用者 codex 設定的
  4 個 MCP servers 只多 1–2 秒。（Claude，moerasermax 指示）
- 順手修正既有突變第 16 案「getModelsPayload 退回每個 alias 各讀一次」的替換片段：payload 那段在同一批
  改動裡改寫過（見下方 `acceptsConfiguredEffort`），舊片段已對不上而讓完整突變測試 ERROR。（Claude）

### 變更（wait 輪詢契約）
- `wait` 逾時改回目前結果陣列，僅仍 running 的項目附 `timedOut: true`，已結束的項目不附 liveness；未知 pid 仍丟錯。CLI 逾時印 JSON 並 exit 3（0 = 全部結束，1 = 錯誤）。同步 MCP 描述、CLI help 與 README，建議以 ≤ 90 秒反覆 wait 並搭配 peek，避免呼叫端把 InternalError 當任務失敗而遺棄 pid；同時移除每輪等待留下的 listener。（@codex-gpt-6-astra，moerasermax 指示）
- Windows detached wrapper 改經 `cmd.exe` 啟動 npm `.cmd` shim，並使用新版 wrapper 檔名，讓 CLI file 路徑確實能啟動並回報 liveness；原本直接 spawn `.cmd` 會被 Node 拒絕，無法完成慢速 stub 驗證。（@codex-gpt-6-astra，moerasermax 指示）

### 新增（GPT-6 Astra 與 codex 的 max / ultra effort）
- **`gpt-6-astra`（GPT-6-Astra）加入 codex 目錄，排在清單最前。** 名稱與能力抄自 codex-cli 的
  `~/.codex/models_cache.json`（2026-09-05）：priority 1、text + image、reasoning 六級
  low / medium / high / xhigh / max / ultra、CLI 端預設 medium。實跑確認：`gpt-6-astra` 配 `ultra`
  與 `max` 都能經由 `run` → `wait` 拿到回答。（Claude，moerasermax 指示；程式碼由
  @codex-gpt-6-astra（xhigh）與 @gemini-3.1-pro 獨立審查——前者 3 項發現全部採納、見下方「變更」，
  後者未發現確信問題）
  - **需要 codex-cli ≥ 0.153.x。** 0.151.0 的 `models_cache.json` 雖然已經列出 `gpt-6-astra`，
    實跑會先報 `Model metadata for gpt-6-astra not found`，接著被 API 以
    `requires a newer version of Codex` 拒絕（HTTP 400）。這台機器已從 0.151.0 升到 0.153.4。
- **codex 的 `reasoning_effort` 多收 `max` 與 `ultra`**；全域集合 `ALLOWED_REASONING_EFFORTS`
  加入 `ultra`。claude 仍只到 `max`：明確傳 `ultra` 給 claude 會以 agent 專屬錯誤拒絕，設定檔給的
  `ultra` 落到 claude 則照舊靜默略過。codex 這邊收的是各模型能力的**聯集**、不按模型細分——同一份
  快取顯示 gpt-5.6-luna 到 max、gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex-spark 仍只到 xhigh；
  不支援的組合由 codex CLI 自己拒絕，錯誤原樣回到呼叫端。（Claude）
- `verify-alias-config.mjs` 新增第 3c 節（8 條）、set_config 段 2 條與第 3 節 1 條（現為 76 項）；
  `tools/mutations.json` 新增 5 個對應突變（31 → 36），全部實測 KILLED、且各自由指定的斷言殺掉。（Claude）
  - 突變測試順帶抓到新斷言自己的弱點：codex 拒收 ultra 時 `buildCliCommand` 會拋例外，原本的
    寫法讓整支腳本當場中斷、後面的 set_config 斷言一條都跑不到——兩個突變因此被判成
    「KILLED(其他斷言)」。改成把例外收成 FAIL 後，4 個突變各自由指定的斷言殺掉。

### 變更（GPT-6 Astra）
- **`codex-ultra` 改指 `gpt-6-astra`，內建預設 effort 由 `xhigh` 改為 `max`**（`ultra` 保留給明確傳入）。
  「codex 最強組合」這個 alias 的意思沒變，變的是最強組合本身；`config.json` 的 `aliasModel` /
  `aliasReasoningEffort` 仍可覆寫。優先序沒動：使用者若在 `config.json` 設了
  `aliasReasoningEffort["codex-ultra"]` 或 `defaultReasoningEffort`，那個值仍然贏過內建的 `max`。
  （Claude，moerasermax 指示）
- `run` 的 `reasoning_effort` 參數描述、`ai-cli run --help`、README 的 alias 表與優先序說明同步更新。
  README 原本拿「codex 不吃 `max`」當靜默略過的例子，現在已不成立，改用「claude 不吃 `ultra`」。（Claude）
- **`models` 回報的 `aliases[].defaultReasoningEffort` 只回報真的會送出的值。** 舊寫法只看該 agent
  「支不支援 reasoning」、不看「值在不在它的允許集合」——設定檔給 `codex-ultra` 的 effort 是 `ultra`、
  `aliasModel` 又把它重指到 `opus` 時，payload 回報 `ultra`，指令裡卻沒有 `--effort`（claude 不吃
  ultra，command-builder 靜默略過）。
  現在「送不送」與「報不報」共用同一條規則 `acceptsConfiguredEffort()`（`core/reasoning.ts`），
  command-builder 也改用它。新增 1 條斷言與 1 個突變。（獨立稽核 @codex-gpt-6-astra 抓到；Claude 修）
- README 的 alias 表與 `run` 的 `model` 參數描述補上 **codex-cli 版本門檻**：`gpt-6-astra`（因此也包括
  `codex-ultra`）需要 0.153 以上，舊版可用 `aliasModel` 暫時指回 `gpt-5.6-sol`。（獨立稽核
  @codex-gpt-6-astra 指出未揭露此相容性條件；Claude 補）

### 修正
- **`agy models` 的查詢從上線起就沒有成功過一次。** 舊解析規則是「整行不含空白才算模型 id」，
  而 agy v1.1.17 的實際輸出是 `<id>	<顯示名稱>`（`gemini-3.1-pro-high	Gemini 3.1 Pro (High)`）
  ——顯示名稱必然帶空白，於是**每一行都被濾掉**，`discoverModels()` 永遠回 `null`，目錄永遠
  降級成 `builtin-fallback`。降級標示本身是誠實的，所以症狀看起來像「agy 查不到」而不像 bug。
  改成取每行第一個空白分隔欄位、且必須長得像模型 id，並先剝掉 ANSI 跳脫序列。修好後
  `models` / `doctor` 對 antigravity 回 `source: vendor-cli`，模型從靜態的 4 個變成實查的 11 個
  （`gemini-3.7/3.6/3.5-flash-{high,medium,low}`、`gemini-3.1-pro-{high,low}`）。（Claude）
  - **這個 bug 本來就有斷言抓得到**：`verify-catalog-source.mjs` 的「★ 有 agy 時真的去問了 CLI」
    在有裝 agy 的機器上從 2026-07-31 起一直是紅的。沒被發現不是因為缺測試，是因為那支測試
    沒在有 agy 的機器上跑過——沒有 agy 的機器會走 SKIP 分支。

### 變更
- `discoverModels()` 只回報**本框架真的會路由到 agy** 的 id。`agy models` 也會列出它代理的
  `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`，但 `matchesAgyModel`
  刻意不收這些名字（靠名字猜會把使用者送到錯的 CLI）。照單全收會讓 `models` 多出
  「列得出來、選了卻被 claude 的 catch-all 接走」的選項。（Claude）
- `matchesModel` 抽成具名匯出的 `matchesAgyModel()`，路由判斷只留一份實作，`discoverModels`
  共用同一份。（Claude）
- **更正兩處對外說明**：`set_config` 的 note 與 `model` 參數描述都還寫著「agy ignores model
  selection entirely / its CLI takes no --model flag」。那是 v1.0.x 的事實，2026-07-31 起
  `buildCommand` 早就在傳 `--model` 了。實測 `--model gemini-3.1-pro-high` 與
  `--model gemini-3.5-flash-high` 會得到不同的模型。（Claude）
- **更正 `matchesModel` 註解裡的一句假用法**：原本寫「要指定『agy 上的 claude』請用目錄的
  `antigravity/claude-sonnet-4-6`」。實查沒有任何地方會拆 `<agent>/<model>`——
  `selectAgentForModel` 只拿整個字串去問 `matchesModel`。那只是目錄的顯示 id，不是呼叫寫法。（Claude）
- `verify-catalog-source.mjs` 的失敗行由 `[FAIL] x` 改成 `FAIL x`，與其他 verify 腳本一致。
  `tools/mutation-test.mjs` 是掃「含 `FAIL ` 的行」判定突變有沒有被對應斷言殺掉，
  `[FAIL]` 一條都對不上——等於這支腳本先前根本無法納入突變測試。（Claude）

- `verify-exec-contract.mjs` 的失敗行同樣由 `[FAIL] x` 改成 `FAIL x`（理由同上）。（Claude）

### 新增
- `parseAgyModelsOutput()` 從 `discoverModels()` 抽出並匯出，改用**錄下來的真實 `agy models`
  輸出**做回歸測試（`verify-catalog-source.mjs` 新增第 3c 節，8 條斷言，27 → 35 項）。
  原本的第 3 節把 `discoverModels` 換成 stub，只驗得到「查不到時要誠實降級」，
  驗不到「查得到時解析對不對」——這次的 bug 正好落在那個洞裡。（Claude）
- 三個對應突變（`tools/mutations.json`，21 → 24）：解析退回舊規則、不剝 ANSI、
  照單全收不過濾路由。三個都實測 KILLED（原地套用＋還原，未走 worktree harness）。（Claude）

### 新增（`exec` 的明確不設限授權）
- **`authority: 'unrestricted'`**。fail-closed 的預設**一個字都沒動**——沒帶 `authority` 的請求
  與從前完全一樣。新增的是一條**明確**的鬆綁：呼叫端自己寫出這個字面值，代表「這次的不設限
  是人授權的、由呼叫端負責」，exec 才改用該 vendor 的一般組裝（帶 `--dangerously-*`）。
  這不是退回——退回是「呼叫端要求限制、我們給不出、卻偷偷放寬」。（Claude）
  - `authority` 與 `capabilities` 同時出現 → 以**語義衝突**為由拒絕，不猜呼叫端想要哪一個。
  - 只認 `'unrestricted'` 字面值；未知值（例如 `'yolo'`）一律拒絕，**不當成沒寫**
    ——當成沒寫會讓呼叫端以為授權生效、實際上受限。
  - `started` frame 新增 `authority` 欄位，回報**實際**生效的模式。版本不合的對端不認識
    這個欄位，於是能發現「要求了 unrestricted 但對方沒生效」而拒絕解讀。
  - 這個設計與它的 8 條斷言是 **2026-08-17 就寫好的**，但 `src/app/exec.ts` 只加了檔頭註解、
    實作從缺，`verify-exec-contract.mjs` 因此一直停在 20/24（其中 4 條連跑都跑不到，
    因為 `planExec` 不存在）。現在 28/28。
- **`planExec()` 匯出**：exec 的決策（選 agent、選組裝、定生效模式）抽成純函式，不 spawn、
  不寫 frame。這條分支若只能靠整跑驗證，每驗一次都要真的啟動一個 vendor CLI——花錢、慢、
  受機器狀態影響，於是實務上就不會有人驗它，而它偏偏是「權限有沒有真的收好」的那條線。（Claude）
- **`splitCatalogModelId()`**：`exec` 支援 `<agent>/<model>` 目錄 id（`codex/gpt-5.3-codex`）。
  前綴不是已知 agent id 時原樣保留——direct-api 的 `or-qwen/qwen3.7-plus` 本來就含斜線，
  拆掉會毀掉那條路徑。目錄 id 指定的 vendor 與名稱路由不一致時（`antigravity/claude-sonnet-4-6`）
  **拒絕**，不做跨 vendor 強制指派。**只在 `exec` 生效，`run` 的路由一行未動。**（Claude）
- 四個對應突變（`tools/mutations.json`，24 → 28）：語義衝突不擋、authority 收下任意值、
  started frame 的 authority 寫死、unrestricted 仍走嚴格組裝。四個都實測 KILLED。（Claude）
  - 其中一個順帶抓出原斷言的弱點：「started frame 帶 authority」原本是掃原始碼有沒有這個字，
    而型別已經逼著這個欄位必須存在（拿掉根本編不過），等於白抓。改成釘 `plan.authority`
    這個**值的來源**——欄位還在、值被寫死成字面值的情況現在會被抓到。

### 變更（模型目錄：列得完整，且每一筆說得出自己能不能派工）

上一版把 agy 的動態查詢修好之後留下兩個洞，這一版一起補：

- **`CatalogEntry` 新增 `routable: boolean`**（由 `agent.matchesModel(model)` 推得，
  不寫死任何 vendor 規則）。vendor 回報的清單可能含本框架送不到它那裡的名字
  ——agy 就代理了 `claude-sonnet-4-6` / `claude-opus-4-6-thinking` / `gpt-oss-120b-medium`，
  那些名字會被 `selectAgentForModel` 送去 claude/codex。（Claude）
- **`discoverModels()` 改成回報 vendor 說的全部**，不在那一層過濾。
  上一版是在 `discoverModels` 就把路由不到的名字濾掉——動機沒錯（避免候選名單出現
  「列得出來、選了卻跑去別家」的選項），但做法錯了：目錄標著 `vendor-cli`
  卻默默少三筆，而「少了」這件事在輸出裡完全看不見。**那正是 catalog-v2 這一層
  存在的理由所要防的病，只是換了個位置發作。** 現在是「列出來並標明」。（Claude）
- **`modelsByAgent()` 改成「靜態清單 ∪ 實查到且可路由的」**。以前只回靜態值，
  於是 agy 查詢修好之後，`catalogV2` 誠實列出 11 個實查模型，而 `run` 的候選名單
  與工具描述還停在寫死的 4 個——**查得到、跑得動、卻沒列在使用者真正會看的地方**
  （實測 `gemini-3.7-flash-low` 可正常派工，但當時沒被列出）。
  只增不減：靜態清單含 `agy` / `agy-default` 這種框架 alias，vendor 永遠不會回報它們，
  砍掉會弄丟有效用法。實查來的只收 `routable` 的。（Claude）

結果：`catalogV2` 列 agy 全部 14 筆（11 可派工 + 3 標明不可路由），
`run` 的候選名單 13 筆（4 靜態 + 9 實查）。claude / codex / direct-api 不受影響。

- 回歸斷言 35 → 41（`verify-catalog-source.mjs`）：routable 是 boolean、標示與實際路由
  一致、候選名單只放可路由的、框架 alias 不消失、實查結果要進候選名單。（Claude）
- 突變 28 → 31（拿掉一個因這次改動而過時的，補四個）：routable 寫死 true / 寫死 false、
  候選名單不過濾 routable、候選名單退回靜態。四個都實測 KILLED。（Claude）

### 其他
- `.gitignore` 補上 `e2e-out.txt`。`verify-e2e.mjs` 每次跑都會重新產生它，
  旁邊的 `mcp-test-out.txt` 早就被忽略了，這個漏了。（Claude）

## [5.0.0] - 2026-07-30

實測全部五個 agent 之後的收斂：Claude 5/5 模型可用、Codex 6/9（3 個被 ChatGPT 帳號層級擋下）、
Antigravity 可用；**Kiro 沒額度**（CLI 回 `Not logged in`）、**Forge 從沒安裝過**
（`resolvedPath: null`）。兩個長期不能用的 agent 拔掉，並把 direct-api 這條
「自己接第三方 API」的路徑補上完整說明——它現在是主要的擴充管道。

### 移除
- **Kiro agent**（`src/agents/kiro.ts`）與其 7 個 model、`kiro-ultra` alias、
  `query_usage` 的 Kiro 供應商。（Claude）
- **Forge agent**（`src/agents/forge.ts`）與 `peek-extractor` 裡整套 Forge 專用擷取策略
  （`extractForgeLines` / Execute-Finished 配對 / stderr 特例）。（Claude）
- `PeekEventExtractor` 的 `source` 建構選項與 `flush()` 的 `terminal` 選項。這兩個**只有**
  forge 的策略在讀，其餘 agent 從來不看；留著會是「看起來有作用、其實沒人讀」的死狀態。（Claude）

### 變更（破壞性）
- `kiro`、`kiro-default`、`kiro-ultra`、`kiro-deepseek-3.2`、`kiro-minimax-m2.5`、
  `kiro-minimax-m2.1`、`kiro-glm-5`、`kiro-qwen3-coder-next`、`forge` 這些 model 名稱
  現在會**丟出明確錯誤**。**這一條是重點**：claude 的 `matchesModel` 是 catch-all 永遠回 true，
  不主動攔的話這些名稱會被 claude 悄悄接走並正常回答，呼叫端根本不會發現自己跑的不是 Kiro。
  攔截點放在 alias 解析之後、`selectAgentForModel` 之前，所以連 alias 形式也擋得到。（Claude）
  - **不受影響**：`forge-<model>` 仍然有效，那會被讀成 direct-api 的 provider `forge` 加 model，
    在更早的 `resolveDirectApiModel()` 就解析走了。
- `AgentId` 收窄為 `claude | codex | antigravity | direct-api`。`CliPaths` 是從它推導的
  （`Record<Exclude<AgentId,'direct-api'>, string>`），所以型別一改，編譯器就把所有殘留點點名出來。（Claude）
- `doctor` 不再回報 Kiro / Forge；`query_usage` 只剩 claude / codex / agy（全部 PTY，
  移除了唯一走 pipe 的 Kiro，連帶簡化 `transport` 判斷）。（Claude）

### 新增
- **README 新增「direct-api：自己接任何第三方 API」專章**：`providers.json` 格式
  （含 `key`/`token`、`baseURL` 等別名寫法）、`or-`/`ds-` 內建前綴與預設端點、
  如何加自訂 provider（DeepSeek / Ollama 等範例）、`<provider>-<model>` 呼叫方式，
  以及能力與限制（工具呼叫、session、`[image:]`、`[no-tools]`、30 次上限、api_key 遮蔽）。（Claude）
- 回歸斷言：`kiro` / `kiro-default` / `kiro-ultra` / `kiro-glm-5` / `forge` 五個名稱
  必須被拒絕**且不得被路由到 claude**（`verify-alias-config.mjs`，60 → 65 項）。
  `verify-mcp.mjs` 另外斷言 models payload 不再有 kiro/forge 區塊與 `kiro-ultra` alias。（Claude）
- 突變 `移除的 model 名稱不攔截（kiro/forge 靜默路由到 claude）`。（Claude）

## [4.1.2] - 2026-07-30

起因是一台機器的 `ai-cli` MCP 連不上（`Failed to reconnect to ai-cli: -32000`），
另一台正常 —— 差別只在兩台註冊了不同的 entry point。

### 修正
- **`ai-cli mcp` 入口一連上就自殺**（從 `66ec771` 框架初版就存在）。`runMcpServer()`
  在 transport 接上的瞬間就 resolve，但呼叫端會合理讀成「server 跑完了」；
  `bin/ai-cli.ts` 正是在 `runCli()` resolve 之後呼叫 `process.exit()`，於是 server 在
  handshake 完成前就死掉（實測 0.2 秒退出、stdout 全空），client 收到
  `MCP error -32000: Connection closed`。改為 `runMcpServer()` 等到
  `waitUntilClosed()` 才 resolve，讓三個入口從「碰巧正確」變成「因設計而正確」。
  另外兩個入口（`dist/server.js`、`dist/bin/ai-cli-mcp.js`）之所以一直沒事，
  只是因為它們沒有呼叫 `process.exit`，不是設計使然。（Claude）
- **`verify-mcp.mjs` 從來只測得到三個入口中的一個**，所以上面那個 bug 活了四個版本
  都沒被抓到 —— 它硬編 `C:\Users\Moera\...\dist\server.js`（另一台機器的絕對路徑）。
  改為相對 `import.meta.url` 解析，並且**三個入口各跑一次完整 smoke test**
  （handshake → 11 個工具 → models → doctor → list_processes）。（Claude）
- **突變 harness 自己的假綠燈**：`tools/mutation-test.mjs` 寫死只跑
  `verify-alias-config.mjs`，任何斷言落在別支腳本的突變都會被判成 SURVIVED。
  新增 `script` 欄位讓每個突變指定負責的 verify 腳本（預設維持
  `verify-alias-config.mjs`），基準檢查也改為逐一驗證用到的每一支。（Claude）
- **突變 harness 在全新機器上直接 crash**：它無條件 `copyFileSync` 備份
  `~/.local/share/ai-cli/config.json`，但使用者從沒改過設定時那個檔並不存在，
  於是 ENOENT 當場中止。改為檔案不存在時跳過備份，收尾改成刪掉測試產生的那份。（Claude）

### 變更
- `package.json` 新增 `prepare: npm run build`。`dist/` 不進版控，clone 後必須編譯，
  現在 `git clone && npm install` 一步到位。（Claude）
- `verify-e2e.mjs` 去掉兩處硬編：server 路徑改為相對 `import.meta.url`，
  工作目錄由 `C:\Users\Moera` 改為 `homedir()`。仍刻意不納入 `npm test`。（Claude）
- README 移除硬編絕對路徑，新增「快速開始」與可直接複製的 `claude mcp add` 指令
  （bash / PowerShell 兩版），並說明三個入口等價、以 `dist/server.js` 為官方推薦。（Claude）

### 新增
- 突變 `runMcpServer 不等 transport 關閉（ai-cli mcp 啟動即自殺）`，由
  `verify-mcp.mjs` 負責抓。（Claude）

## [4.1.1] - 2026-07-30

全部來自 v4.1.0 的**發版後驗收稽核**（@codex xhigh，唯讀＋實跑）。
逐條處置見 [`docs/audits/2026-07-30-v4.1.1.md`](./docs/audits/2026-07-30-v4.1.1.md)。

### 修正
- **回歸：`set_config` 又會拿空基底覆寫設定檔（資料遺失）**。4.1.0 把讀取端的
  「結構性錯誤」集合從 `{ENOENT, ENOTDIR}` 擴大到含 `EISDIR` / `ELOOP` / `ENAMETOOLONG`，
  但 `readRawConfig()`（寫入端的基底）共用同一個判斷 —— 於是「路徑上有東西、只是讀不到」
  被當成「檔案不存在」，正好推翻 4.1.0 自己承諾的「只有檔案不存在才用空基底」。
  寫入端改回只認 `ENOENT`。**兩端的判準必須分開**：讀取端問「這次該用什麼值」，
  寫入端問「覆蓋下去會不會弄丟還在的東西」。（Claude；@codex 稽核指出）
- **突變測試工具自己的假綠燈**：收尾的 `run('git', ['status','--short'])` 因為 `run()`
  只吃一個參數陣列而**根本沒執行 git**，卻把空字串印成「worktree 乾淨」；
  同時還原時寫回的是 LF 正規化後的內容，實際上每輪都把 worktree 弄髒。
  改為分出 `exec(cmd,args)`、還原寫回原始 bytes、與開跑時的 `git status` 比對，
  不一致就以非零碼收場。（Claude；@codex 稽核指出）
- **`verify-e2e.mjs` 只看輸出長度**：「CLI 失敗但吐了一段錯誤訊息」會被判成成功。
  改為同時檢查 `status` / `exitCode` / 是否真的回 `PONG`。（Claude；@codex 稽核指出）
- **`verify-direct-api.mjs` 的暫存目錄清理只在成功路徑**：assertion 中途拋錯仍會留垃圾。
  改掛 `process.on('exit')`。（Claude；@codex 稽核指出）

### 變更
- **突變 14 → 19 個**：補上寫入端錯誤分類、根節點陣列、`aliasReasoningEffort` 陣列、
  `ELOOP`、`getModelsPayload(snapshot)` 不重讀。補的過程中突變測試又抓出兩條原本
  **不夠力的斷言**（根節點陣列擋不擋都回內建值，分辨不出來；三個結構性 code 寫成迴圈時，
  第一個會清掉快取讓後面的失去鑑別力），一併改強。（Claude）
- **測試 49 → 60 項**。（Claude）

### 更正（先前敘述不實）
- v4.1.0 的稽核紀錄稱「把**每個**修補逐一改壞」—— 實際只涵蓋產品端，
  測試基礎設施的修補沒有突變覆蓋。已改寫。（@codex 稽核指出）
- v4.1.0 的「API 變更**皆**向後相容」不成立：`updateUserConfig()` 回傳型別由
  `UserConfig` 改為 `ConfigSnapshot`，舊呼叫端若直接取 `.aliasModel` 會壞。
  見下方 4.1.0 的更正標註。（@codex 稽核指出）

## [4.1.0] - 2026-07-29

本版的重點是**設定檔讀寫的韌性**，全部屬於「不報錯、只安靜做錯事」那一類。
驗證方式與兩份獨立稽核的逐條處置見 [`docs/audits/2026-07-29-v4.1.0.md`](./docs/audits/2026-07-29-v4.1.0.md)。

### 修正
- **讀取錯誤的分類**：`ENOENT` / `ENOTDIR` / `EISDIR` / `ELOOP` / `ENAMETOOLONG` 屬**結構性**
  （不會自己好）→ 退回內建預設；`EBUSY` / `EPERM` / `EACCES` 等屬**暫時性** → 沿用 last-good。
  分界點是「再試一次有沒有可能成功」，不是「錯誤嚴不嚴重」。原本只有前兩個算結構性，
  於是「設定檔路徑被同名目錄佔住」這種永遠好不了的情況會讓一份讀不到的設定無限期存活。
  （Claude；@codex 稽核指出）
- **陣列型 `aliasModel` 會經由 `set_config` 復活成垃圾 alias**：parser 會忽略陣列，
  但 `set_config` 直接 spread 它 —— `{ ...['a','b'] }` 產生 `{"0":"a","1":"b"}` 寫回磁碟，
  那些數字 key 就從「被忽略」升級成「parser 認可的 alias」。非普通物件一律不 spread。
  （Claude；@codex 稽核指出）
- **`describeUserConfig()` 可能回報「A 版設定配 B 版狀態」**：它吃外部傳入的 config，
  卻搭配模組層級的 `lastStatus`。改為引入 `ConfigSnapshot { config, status }` 把兩者綁成一包傳遞。
  （Claude；@codex 稽核指出）
- **`set_config` 仍讀兩次設定檔**：`updateUserConfig()` 讀一次，回傳值被丟掉後
  `getModelsPayload()` 又讀一次 —— 中間有別的 writer 介入時，回傳的 payload 描述的
  就不是本次寫入的結果。改為直接把剛寫入的 snapshot 傳給 `getModelsPayload()`。
  （Claude；@codex 稽核指出）
- **`verify-e2e.mjs` 無論結果都 `process.exit(0)`**：三家 CLI 全都沒回應也會被讀成通過。
  （Claude；@gemini-3.1-pro 稽核指出）
- **`npm test` 沒有跑 `verify-mcp.mjs`**：MCP handshake 與工具清單完全在測試範圍外。串進 chain。
  （Claude；@gemini-3.1-pro 稽核指出）
- **`verify-alias-config.mjs` 的還原可能毀掉使用者設定**：測試中途會把 `config.json` 換成
  同名目錄，若殘留，還原時的 `copyFileSync` 會拿到 `EISDIR` 而拋錯 —— 使用者的設定就只剩備份檔。
  改為還原前強制清掉殘留目錄，並註冊 SIGINT/SIGTERM/SIGHUP/SIGBREAK。
  （Claude；@gemini-3.1-pro 稽核指出）
- **`verify-direct-api.mjs` 每跑一次就在 `%TEMP%` 留一個目錄**。（Claude；@gemini-3.1-pro 稽核指出）

### 新增
- **突變測試工具 `tools/mutation-test.mjs` + `tools/mutations.json`**：把**產品端**的修補
  逐一改壞，斷言「對應的測試必須 FAIL」。用來抓假綠燈 —— 這個專案已經吃過三次虧。
  在獨立 git worktree 上跑，不碰主工作目錄。本版 14 個突變全部 KILLED
  （測試基礎設施本身的修補沒有突變覆蓋；v4.1.1 補到 19 個）。
  新增修補時請順手加一個對應突變。（Claude）
- **`models` 的 `userConfig` 新增 `status` 欄位**：`fresh` / `missing` / `stale`（正在沿用
  last-good，附 `errorCode`）/ `error`。`exists` 也改由同一次載入推導，不再另外 `existsSync`
  ——否則會出現「`exists: true` 但回報的其實是 last-good 舊值」這種互相矛盾的診斷。（Claude）
- **設定物件會被 `Object.freeze`**：回傳的是共用參照，凍結後將來若有人誤改會當場丟錯而不是
  靜默污染所有後續讀取（目前所有呼叫端都已確認是唯讀）。（Claude；@gemini-3.1-pro 稽核指出）
- **稽核紀錄 `docs/audits/`**：逐條記錄稽核發現、判定（採納／駁回）與處置。（Claude）

### API 變更
- 新增 exported `loadUserConfigSnapshot()`、`ConfigSnapshot`、`ConfigStatus`。（向後相容）
- **不相容**：`updateUserConfig()` 回傳型別由 `UserConfig` 改為 `ConfigSnapshot`
  —— 直接取用回傳值欄位（如 `.aliasModel`）的呼叫端要改成 `.config.aliasModel`。
  本 repo 內唯一呼叫端是 `set_config`，已一併更新。
  （原本誤記為「皆向後相容」，由 v4.1.1 的驗收稽核更正。）
- `resolveConfiguredAliasModel` / `resolveConfiguredReasoningEffort` / `resolveModelAlias` /
  `getEffectiveAliasDetails` / `getModelsPayload` / `describeUserConfig` 新增**可選**的
  config/snapshot 參數；不傳時行為與原本相同。
- `set_config` 在設定檔讀不到或內容壞掉時，由「靜默成功並覆寫」改為**丟出明確錯誤**。

### 已知限制（本版明確記錄，未修）
- **手動編輯的 `aliasModel` 不會被驗證**：`set_config` 會擋掉不存在的 model，直接編輯設定檔則不會
  ——打錯字會被 catch-all 的 claude agent 靜默接走。`user-config` 不能 import `catalog`
  （會循環依賴），所以驗證只能放在消費端。可用 `models` 的 `agent` 欄位自檢。
- **多 process 並發寫入會遺失更新**：`set_config` 是無鎖的 read-modify-rename。

### 同版稍早的修正（commit `a5d5fa9`）
- **`set_config` 在設定檔讀不到／壞掉時會把它整份覆寫掉（資料遺失）**：`readRawConfig()` 原本
  對任何讀取或解析錯誤都回 `{}`，於是鎖檔的瞬間或使用者手改壞 JSON 之後，`set_config` 會拿
  **空基底**套上 patch 再寫回去 —— 原有設定與所有未知欄位就沒了。改為只有「檔案不存在」
  才用空基底，其餘一律丟出明確錯誤（寧可讓 `set_config` 失敗，也不能靜默覆寫）。（Claude；@codex 稽核指出）
- **讀檔失敗會靜默退回內建值**：`loadUserConfig()` 改成每次讀檔後，Windows 上撞到別的 process
  做 tmp+rename 或防毒鎖檔的機會變大；原本任何讀取錯誤都回 `{}`，等於那一次 run **悄悄換成
  另一個 model / reasoning**。現在區分 `ENOENT`／`ENOTDIR`（檔案真的不存在 → 用內建值）與
  其他錯誤（暫時性 → 沿用上一次成功的設定 last-good）。（Claude）
- **UTF-8 BOM 讓整份設定靜默失效**：Windows 記事本與 PowerShell 5.1 的 `Set-Content` 會寫出
  帶 BOM 的檔案，`JSON.parse` 遇到開頭的 U+FEFF 直接丟 `SyntaxError` → 設定全部不生效。
  讀檔後剝除 BOM。（Claude；@gemini-3.1-pro 稽核指出）
- **解析失敗後舊設定會「復活」**：JSON 壞掉時回 `{}` 但沒清快取，接著一次讀檔失敗就會把這份
  已作廢的舊設定當成 last-good 端出來。改為解析失敗即清快取。（Claude；@gemini-3.1-pro 稽核指出）
- **`aliasModel` / `aliasReasoningEffort` 是陣列時會產生垃圾 alias**：`typeof [] === 'object'`，
  `Object.entries` 會解出 `"0"` / `"1"` 這種 key。三處都補上 `Array.isArray` 檢查。（Claude；@gemini-3.1-pro 稽核指出）
- **同一次操作可能混用兩個版本的設定**：`buildCliCommand()` 原本讀 2 次設定檔（一次解析 alias、
  一次取 reasoning）、`getModelsPayload()` 讀 8 次，中間只要檔案被改動就會組出「A 版 alias +
  B 版 reasoning」這種兩邊都不對的結果。改為在操作入口載入一份 snapshot 往下傳，
  **兩者都降為 1 次讀取**，並加上讀取次數的回歸斷言。（Claude；@codex 稽核指出）
- **`updateUserConfig()` 寫入後重讀的空窗**：原本「清快取 → 重讀」，中間讀檔失敗時 last-good
  是空的，會回報一份跟磁碟上不一樣的設定。改為直接用剛寫出去的文字建立快取，也省掉一次讀檔。（Claude；@codex 稽核指出）

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

[Unreleased]: https://github.com/moerasermax/ai-cli-mcp-source/compare/v4.1.1...HEAD
[4.1.1]: https://github.com/moerasermax/ai-cli-mcp-source/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/moerasermax/ai-cli-mcp-source/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/moerasermax/ai-cli-mcp-source/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/moerasermax/ai-cli-mcp-source/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/moerasermax/ai-cli-mcp-source/releases/tag/v3.0.0
