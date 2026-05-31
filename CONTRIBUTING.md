# 共同維護準則（CONTRIBUTING）

這個框架的目標是**開放給所有專案共用**，且每位協作者都有修改權限。正因為共用，
「誰改了什麼、為什麼改」必須留下可追溯的紀錄——這是本準則的核心。

> 一句話原則：**每一次改動，都要在 commit 與 CHANGELOG 留下足夠讓別人看懂的紀錄。**

---

## 1. 改動前

1. 先 `git pull`（或同步最新），避免在舊基礎上改。
2. 較大的功能或會動到 `core/` 框架本體的改動，先在 issue / 討論串說明動機。
3. 從 `master` 切出工作分支：`git checkout -b <type>/<簡述>`，例如 `feat/circuit-breaker`。

## 2. 改動中

- **新增 AI agent**：照 `README.md`「新增一個 AI agent」步驟，只動 `agents/` 與少數註冊點，不要改 `core/`。
- **改框架本體（`core/`）**：影響所有 agent，務必謹慎，並在 PR 描述列出影響範圍。
- 維持既有風格：繁體中文註解、檔頭用區塊註解說明該檔職責、對外行為改動要標註。
- 改完一定要能編譯：`npm run build`（或 `npm run typecheck`）必須零錯誤。
- 有對應的驗證腳本（`verify-*.mjs`）時，跑過確認通過；新功能盡量補一支。

## 3. 改動的紀錄（最重要）

每一次改動都要在**兩個地方**留痕，缺一不可：

### 3.1 Commit message —— 採 Conventional Commits

格式：`<type>(<scope>): <用繁體中文寫的簡述>`

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重構，不改對外行為 |
| `docs` | 只改文件 |
| `chore` | 雜項（建置、相依、設定） |
| `test` | 測試/驗證腳本 |

範例：`feat(core): 新增 AI 啟動熔斷器，避免框架迴圈造成供應商誤判`

commit 內文（body）說明**為什麼這樣改**，而不只是改了什麼。

### 3.2 CHANGELOG.md

- 所有「使用者/協作者看得到的行為變化」都要在 `CHANGELOG.md` 的 `[Unreleased]` 區段補一行。
- 格式採 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)：分 `新增 / 變更 / 修正 / 移除`。
- 每筆結尾用括號標註作者，例如：`（@moerasermax）`，方便日後追責任人。
- 發版時把 `[Unreleased]` 的內容歸到新的版本號與日期下。

> 為什麼要這麼嚴格：這個框架被多個專案、多位協作者共用，少了紀錄，
> 一旦某次改動引發問題（尤其是 `core/` 的改動），就很難回溯是誰、為什麼改的。

## 4. 版本號（SemVer）

`package.json` 的 `version` 遵循語意化版本：

- **MAJOR**：破壞性變更（對外 MCP 行為或介面不相容）。
- **MINOR**：新增向後相容的功能（如新 agent、新工具、熔斷器）。
- **PATCH**：向後相容的修正。

## 5. 送出改動

1. `npm run build` 通過、相關 `verify-*.mjs` 通過。
2. commit（遵循 §3.1）、push 分支。
3. 開 PR，描述：**動機 / 改了什麼 / 影響範圍 / 如何驗證**。
4. 動到 `core/` 的 PR 至少要有一位其他協作者 review。

## 6. 不要提交的東西

`dist/`、`node_modules/`、`.env*`、各種 `*.log` 已在 `.gitignore`。
請勿提交個人路徑、token、帳號憑證。
