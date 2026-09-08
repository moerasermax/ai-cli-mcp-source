/**
 * 【產生檔，請勿手改】由 tools/sync-plugin-core.mjs 於 npm run build 後從
 * dist/core/verification.js 複製而來，來源是 src/core/verification.ts。
 *
 * 之所以要複製一份進版控：dist/ 不進版控，而 plugin 從 marketplace 安裝時拿到的
 * 只有版控裡的檔案。hook 必須自足，否則在正式安裝的機器上會因為找不到判定模組
 * 而永久靜默放行。
 *
 * 要改判定邏輯請改 src/core/verification.ts，然後 npm run build。
 * 兩邊不一致時 verify-verification.mjs 會 FAIL。
 */
/**
 * 程式碼修改的驗證狀態判定（第 1 層：觀察子 agent；第 2 層 plugin 重用同一套語意）。
 *
 * 動機：2026-09-08 的 transcript 實測顯示，有改到程式碼的工作段裡有 31.7% 完全沒跑
 * 任何 test/build，而且這個比例隨上下文長度上升（0-200k 是 5%、600-800k 是 59%）。
 * 呼叫端是 AI，它只看得到工具回傳——回傳沒說「這次沒驗證」，它就會當作驗過了。
 * 這跟 2026-09-05「wait 逾時不丟錯、改回 liveness」是同一個哲學：工具要對 AI 說實話。
 *
 * **刻意不是布林值**。`verified: false` 沒辦法區分「沒改程式碼所以不用驗」、
 * 「改了但我看不到它有沒有驗」、「驗了而且失敗」這三件完全不同的事，
 * 而它們對呼叫端的下一步有完全不同的意義。所以是五態。
 *
 * **驗證必須發生在最後一次修改之後**。先跑測試再改程式碼，測試結果不能算數——
 * 那是這套判定最容易被說成「假通過」的地方，所以用事件順序而不是「有沒有出現過」。
 */
/** 會被當成「程式碼」的副檔名。文件、設定、資料不算——改 README 不需要跑測試。 */
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|cc|hpp|rb|php|swift|kt|kts|scala|sh|bash|ps1|sql|vue|svelte|dart|ex|exs|lua|mm|pl)$/i;
/**
 * 單字母副檔名（C、標頭、Objective-C、R）**必須有路徑證據**才算程式碼。
 *
 * 2026-09-08 閘門誤擋自己時抓到：Python 的 `re.M`、`re.S` 這種 flag，
 * 以及任何 `物件.c` 形式的屬性存取，都會被單純的副檔名比對當成程式碼檔案。
 * 要求 token 含路徑分隔符，才不會把一個 regex flag 當成 Objective-C 原始碼。
 */
const CODE_EXT_SINGLE = /\.(c|h|m|r)$/i;
function looksLikeCodePath(token) {
    if (CODE_EXT.test(token))
        return true;
    return CODE_EXT_SINGLE.test(token) && /[\\/]/.test(token);
}
/**
 * 直接改檔的工具。
 * `file_change` 是 codex 的形狀（它改檔不走 shell），由 agents/codex.ts 展開成每檔一筆。
 */
const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file|file_change)$/i;
/** 跑得起來就算驗證的指令。跟 baseline 腳本用同一套，換掉要兩邊一起換。 */
const VERIFY_CMD = /(npm\s+(run\s+)?(test|build|lint|typecheck)|yarn\s+(test|build|lint)|pnpm\s+(test|build|lint)|npx\s+(tsc|vitest|jest|eslint)|pytest|python\s+-m\s+pytest|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|dotnet\s+(test|build)|mvn\s+(test|verify)|gradle\s+(test|build)|\btsc\b|vitest|jest|eslint|ruff|mypy|make\s+(test|check|build))/i;
/**
 * 只是把指令字串印出來，不是真的跑。
 * `echo "npm test"` 不能算驗證過——那是最廉價的偽造方式（codex 稽核抓到）。
 */
const ECHOED = /^\s*(echo|printf|print|cat|type|write-host|write-output)\b/i;
/**
 * 搜尋類指令：引號裡那串是**要找的東西**，不是要跑的東西。
 *
 * 2026-09-08 astra 稽核抓到的假通過：改完程式碼之後只跑
 * `rg "npm test" README.md`，判定就回報 passed——因為指令字面上有 `npm test`。
 * 閘門謊報通過比誤擋嚴重得多，因為呼叫端會信它。
 */
const SEARCH_CMD = /(^|[\s;&|])(rg|grep|egrep|fgrep|ag|ack|findstr|Select-String|sls)\b|\bgit\s+log\b[^|;&]*--grep/i;
/**
 * 把引號內的內容換成空白。
 *
 * 只用在**判斷有沒有寫檔**：`echo "example > src/a.ts"` 裡的 `>` 是文字不是重導向
 * （astra 稽核抓到，實測成立）。剝掉之後 `echo "x" > src/gen.ts` 仍看得到真的重導向。
 *
 * **刻意不用在判斷有沒有跑驗證**：`pwsh.exe -Command "npm test"` 的引號裡是真的要執行的
 * 指令，剝掉就會漏掉——codex 在 Windows 上就是這個形狀。那一側改用 SEARCH_CMD 排除。
 */
function stripQuoted(command) {
    return command.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}
/** 「零失敗」的說法。這些出現時，不可以因為字面有 failed 就判成失敗。 */
const ZERO_FAIL = /\b0\s+(tests?\s+)?(failed|failing|failures|errors)\b|\ball tests? passed\b|\bno tests? failed\b/i;
/**
 * 沒有 exit code 可用時，從輸出文字判失敗。
 *
 * 刻意**不**比對裸的小寫 `failed`——`49 passed, 0 failed` 是最常見的成功輸出，
 * 舊版會把它判成失敗（2026-09-08 codex 稽核抓到，實測成立）。改成只認
 * 「非零個失敗」與明確的失敗標記。有 exit code 時一律以 exit code 為準。
 */
const FAIL_TEXT = /(\bFAIL\b(?![=:\s]*0\b)|[1-9]\d*\s+(tests?\s+)?(failed|failing|failures)|not ok|error TS\d|AssertionError|exit code [1-9])/;
/** Windows 磁碟機、UNC 或 POSIX 絕對路徑。 */
function isAbsolutePath(path) {
    return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}
/**
 * 路徑正規化：統一斜線、解析掉 `.` 與 `..`、Windows 上去掉大小寫差異。
 *
 * `..` 必須真的解析，不能只做字面比對——否則 `C:\proj\..\outside\evil.ts`
 * 會因為字首是 `C:\proj` 而被當成專案內（2026-09-08 codex 稽核抓到）。
 * POSIX 檔案系統大小寫敏感，只在 win32 折疊大小寫。
 */
function canonical(path) {
    const unified = path.replace(/\\/g, '/');
    const leadingSlash = unified.startsWith('/');
    const segments = [];
    for (const segment of unified.split('/')) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (segments.length > 0 && segments[segments.length - 1] !== '..')
                segments.pop();
            else
                segments.push('..');
            continue;
        }
        segments.push(segment);
    }
    const joined = (leadingSlash ? '/' : '') + segments.join('/');
    return process.platform === 'win32' ? joined.toLowerCase() : joined;
}
/**
 * target 是否位於 projectRoot 底下。沒給 root 就一律算數（維持舊行為）。
 *
 * 相對路徑**接到 projectRoot 上再判斷**，不是一律放行——`../outside/evil.ts`
 * 是相對路徑，但它指向專案外面。
 */
function insideProject(target, projectRoot) {
    if (!projectRoot)
        return true;
    const root = canonical(projectRoot);
    if (!root)
        return true;
    const file = canonical(isAbsolutePath(target) ? target : `${projectRoot}/${target}`);
    return file === root || file.startsWith(root + '/');
}
/**
 * 丟棄輸出的目標。寫到這裡不是改檔。
 *
 * 這是**第二層**防護：主要保護是下面「目標必須看起來像程式碼檔」那一關，
 * 而 `/dev/null`、`NUL` 本來就沒有程式碼副檔名。突變測試證實拿掉這一層也不會
 * 讓任何斷言變紅——保留它是為了萬一 looksLikeCodePath 之後放寬，
 * 但不要誤以為它是唯一擋住 `2>/dev/null` 的東西。
 */
const NULL_SINK = /^(\/dev\/null|nul|NUL|\/dev\/stdout|\/dev\/stderr|&\d)$/i;
/**
 * 撈出一個 shell 指令**實際寫入的目標**。
 *
 * 舊版是「指令裡有沒有寫檔動作」AND「指令裡有沒有程式碼路徑 token」分開判，
 * 但那兩件事可能毫無關係：`grep x src/a.ts 2>/dev/null` 的寫入目標是 /dev/null，
 * 跟 src/a.ts 無關，卻會被判成改了 src/a.ts（2026-09-08 第二次誤擋自己時抓到，
 * 第一次是 `->` 被當成重導向）。
 *
 * 現在只看目標本身：重導向取 `>` 後面那個 token，tee / mv / cp 取它們的目的地，
 * `sed -i` 則因為目標可能夾在多個旗標之間，退回掃整串 token。
 *
 * 重導向的 `>` 要求前接行首／空白／`;&|)`／fd 數字，同樣是第二層防護——
 * 就算拿掉，`->` 抓到的目標 `readTime` 也不是程式碼檔而不會誤判。
 */
function shellWriteTargets(rawCommand) {
    // 引號裡的 `>` 是文字不是重導向，先剝掉再找目標。
    const command = stripQuoted(rawCommand);
    const targets = [];
    const push = (value) => {
        if (value && !NULL_SINK.test(value))
            targets.push(value);
    };
    for (const m of command.matchAll(/(?:^|[\s;&|)])\d?>{1,2}\s*([^\s>|&;]+)/g))
        push(m[1]);
    for (const m of command.matchAll(/\btee\s+(?:-\S+\s+)*([^\s>|&;]+)/gi))
        push(m[1]);
    for (const m of command.matchAll(/\b(?:mv|cp)\s+(?:-\S+\s+)*\S+\s+([^\s>|&;]+)/gi))
        push(m[1]);
    for (const m of command.matchAll(/\b(?:dd\s+of=|install\s+-D\s+)([^\s>|&;]+)/gi))
        push(m[1]);
    // sed -i / patch 的目標位置不固定，只好掃整串。
    if (/(^|[\s;&|])(sed\s+(-\S*\s+)*-i|patch\s)/i.test(command)) {
        for (const token of command.match(/[^\s'"<>|&;()]+/g) ?? [])
            push(token);
    }
    return targets;
}
function commandOf(input) {
    if (!input || typeof input !== 'object')
        return '';
    const record = input;
    const command = record.command ?? record.cmd ?? record.script;
    return typeof command === 'string' ? command : '';
}
function pathOf(input) {
    if (!input || typeof input !== 'object')
        return '';
    const record = input;
    const target = record.file_path ?? record.path ?? record.filePath ?? record.notebook_path;
    return typeof target === 'string' ? target : '';
}
function outputText(output) {
    if (typeof output === 'string')
        return output;
    if (!output || typeof output !== 'object')
        return '';
    const record = output;
    if (typeof record.text === 'string')
        return record.text;
    if (Array.isArray(record.content)) {
        return record.content
            .map((part) => (part && typeof part === 'object' ? String(part.text ?? '') : String(part ?? '')))
            .join('\n');
    }
    return '';
}
/**
 * 把單筆 agent 工具紀錄正規化。
 *
 * claude 記的是 `{ tool: 'Bash', input, output }`（tool 名就是 Claude Code 的工具名）；
 * codex 記的是 `{ tool: 'command_execution', input: { command }, output, exit_code }`
 * 以及 `{ server, tool, input, output }` 的 MCP 呼叫。exit_code 存在時優先用它，
 * 因為文字比對會把「測試輸出裡剛好有 error 字樣」誤判成失敗。
 */
export function normalizeToolEvent(entry, options = {}) {
    if (!entry || typeof entry !== 'object')
        return { kind: 'other', label: '' };
    const record = entry;
    const tool = String(record.tool ?? record.name ?? '');
    const input = record.input;
    const command = commandOf(input);
    const target = pathOf(input);
    const { projectRoot } = options;
    if (EDIT_TOOL.test(tool) && target) {
        return looksLikeCodePath(target) && insideProject(target, projectRoot)
            ? { kind: 'code_change', label: `${tool} ${target}` }
            : { kind: 'other', label: `${tool} ${target}` };
    }
    if (command) {
        /*
          **改檔要先判**。一個指令可能同時做兩件事（`sed -i src/a.ts && npm test`），
          舊版先認驗證就直接回傳，那次修改等於憑空消失——後續若再有一次驗證，
          整體就會被判成 passed（假通過）。無法從單一事件知道兩者的先後，
          所以保守當成「有改檔、尚未驗證」：寧可多要求跑一次測試，也不要放過假通過。
        */
        const writesCode = shellWriteTargets(command).some((target) => looksLikeCodePath(target) && insideProject(target, projectRoot));
        if (writesCode) {
            return { kind: 'code_change', label: command.trim().slice(0, 160) };
        }
        if (VERIFY_CMD.test(command) && !ECHOED.test(command) && !SEARCH_CMD.test(command)) {
            const exitCode = record.exit_code ?? record.exitCode;
            const text = outputText(record.output);
            const ok = typeof exitCode === 'number'
                ? exitCode === 0
                : ZERO_FAIL.test(text) || !FAIL_TEXT.test(text);
            return { kind: 'verification', label: command.trim().slice(0, 160), ok };
        }
    }
    return { kind: 'other', label: tool };
}
/**
 * 判定驗證狀態。
 *
 * @param events 已正規化且**按時間排序**的事件。順序是判定的全部依據——
 *               呼叫端若打亂順序，passed 就會失去意義。
 * @param options.structured 這個 agent 有沒有結構化工具紀錄。antigravity 沒有，
 *               它的「沒看到驗證」不能當成「沒驗證」，只能是 not_observed。
 * @param options.waivedReason 呼叫端明確豁免時給的理由；有理由才算 waived。
 */
export function classifyVerification(events, options = {}) {
    const { structured = true, waivedReason = null } = options;
    const lastChangeIndex = events.reduce((found, event, index) => (event.kind === 'code_change' ? index : found), -1);
    const evidence = {
        lastCodeChange: lastChangeIndex >= 0 ? events[lastChangeIndex].label : null,
        verificationsAfterChange: [],
        failedVerifications: [],
        staleVerifications: 0,
    };
    for (let index = 0; index < events.length; index++) {
        const event = events[index];
        if (event.kind !== 'verification')
            continue;
        if (index < lastChangeIndex) {
            evidence.staleVerifications++;
            continue;
        }
        evidence.verificationsAfterChange.push(event.label);
        if (event.ok === false)
            evidence.failedVerifications.push(event.label);
    }
    if (!structured) {
        return {
            status: 'not_observed',
            reason: 'this agent emits no structured tool history, so neither code changes nor verification could be observed — check the diff yourself before trusting this result',
            evidence,
        };
    }
    if (lastChangeIndex < 0) {
        return {
            status: 'not_applicable',
            reason: 'no source-code file was modified, so no verification was required',
            evidence,
        };
    }
    if (evidence.failedVerifications.length > 0) {
        return {
            status: 'failed',
            reason: `verification ran after the last code change and FAILED (${evidence.failedVerifications.length} of ${evidence.verificationsAfterChange.length}) — do not treat this work as done`,
            evidence,
        };
    }
    if (evidence.verificationsAfterChange.length > 0) {
        return {
            status: 'passed',
            reason: `verification ran after the last code change and passed (${evidence.verificationsAfterChange.length} command(s))`,
            evidence,
        };
    }
    if (waivedReason) {
        return {
            status: 'waived',
            reason: `code was changed without verification, explicitly waived: ${waivedReason}`,
            evidence,
        };
    }
    const stale = evidence.staleVerifications > 0
        ? ` ${evidence.staleVerifications} verification(s) ran BEFORE the last edit and do not count`
        : '';
    return {
        status: 'not_observed',
        reason: `code was changed (${evidence.lastCodeChange}) but no verification ran afterwards.${stale} Run the project's tests or build before relying on this result`,
        evidence,
    };
}
/**
 * 從 agent 的 `tools` 陣列產出報告。**一律回報，不回 null。**
 *
 * 舊版在「有結構化紀錄能力但這次沒有 tools」時回 null，等於多出一個沒有名字的
 * 第七態「欄位缺席」，跟 process-result 宣稱的「一律回報」自相矛盾
 * （2026-09-08 codex 稽核抓到）。現在分成兩種明確狀態：
 *   - 有記錄能力、這次沒有工具事件 → `not_applicable`（真的沒動到檔案）
 *   - 沒有記錄能力（agy） → `not_observed`（看不到，不是沒有）
 */
export function verificationFromAgentOutput(agentOutput, options = {}) {
    const tools = agentOutput && typeof agentOutput === 'object'
        ? agentOutput.tools
        : undefined;
    if (!Array.isArray(tools)) {
        return classifyVerification([], options);
    }
    // 注意不要寫成 tools.map(normalizeToolEvent)：map 會把 index 當第二參數傳進去。
    const projectRoot = options.projectRoot ?? null;
    return classifyVerification(tools.map((entry) => normalizeToolEvent(entry, { projectRoot })), options);
}
//# sourceMappingURL=verification.js.map