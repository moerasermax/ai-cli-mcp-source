# 變更紀錄（Changelog）

本檔記錄所有對使用者/協作者可見的改動。格式參考
[Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循
[語意化版本](https://semver.org/lang/zh-TW/)。每筆結尾以括號標註作者。

維護規則見 [CONTRIBUTING.md](./CONTRIBUTING.md)：**每次改動都要在此補一行。**

## [Unreleased]

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


### 新增
- `parseAgyModelsOutput()` 從 `discoverModels()` 抽出並匯出，改用**錄下來的真實 `agy models`
  輸出**做回歸測試（`verify-catalog-source.mjs` 新增第 3c 節，8 條斷言，27 → 35 項）。
  原本的第 3 節把 `discoverModels` 換成 stub，只驗得到「查不到時要誠實降級」，
  驗不到「查得到時解析對不對」——這次的 bug 正好落在那個洞裡。（Claude）
- 三個對應突變（`tools/mutations.json`，21 → 24）：解析退回舊規則、不剝 ANSI、
  照單全收不過濾路由。三個都實測 KILLED（原地套用＋還原，未走 worktree harness）。（Claude）

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
