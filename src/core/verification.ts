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

/** 五態。`not_observed` 是「不知道」，不是「沒有」——兩者對呼叫端意義不同。 */
export type VerificationStatus =
  | 'not_applicable'
  | 'not_observed'
  | 'passed'
  | 'failed'
  | 'waived';

export interface VerificationEvidence {
  /** 最後一次改到程式碼的動作（工具名 + 目標），沒有則 null。 */
  lastCodeChange: string | null;
  /** 最後一次修改之後跑過的驗證指令。 */
  verificationsAfterChange: string[];
  /** 其中失敗的那些。 */
  failedVerifications: string[];
  /** 在最後一次修改「之前」就跑掉的驗證，只用來解釋為什麼不算數。 */
  staleVerifications: number;
}

export interface VerificationReport {
  status: VerificationStatus;
  /** 給 AI 讀的一句話，說明這個狀態代表什麼、下一步該做什麼。 */
  reason: string;
  evidence: VerificationEvidence;
}

/** 會被當成「程式碼」的副檔名。文件、設定、資料不算——改 README 不需要跑測試。 */
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|cc|c|h|hpp|rb|php|swift|kt|kts|scala|sh|bash|ps1|sql|vue|svelte|dart|ex|exs|lua|m|mm|pl|r)$/i;

/**
 * 直接改檔的工具。
 * `file_change` 是 codex 的形狀（它改檔不走 shell），由 agents/codex.ts 展開成每檔一筆。
 */
const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file|file_change)$/i;

/** shell 裡也能改程式碼：重導向、sed -i、tee、patch、mv/cp 到程式碼檔。 */
const SHELL_WRITE =
  /(^|[\s;&|])(sed\s+(-[^\s]*\s+)*-i|patch\s|tee\s|dd\s+of=|install\s+-D)|>\s*[^\s>|&]+|>>\s*[^\s>|&]+|\b(mv|cp)\s+[^\s]+\s+[^\s]+/i;

/** 跑得起來就算驗證的指令。跟 baseline 腳本用同一套，換掉要兩邊一起換。 */
const VERIFY_CMD =
  /(npm\s+(run\s+)?(test|build|lint|typecheck)|yarn\s+(test|build|lint)|pnpm\s+(test|build|lint)|npx\s+(tsc|vitest|jest|eslint)|pytest|python\s+-m\s+pytest|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|dotnet\s+(test|build)|mvn\s+(test|verify)|gradle\s+(test|build)|\btsc\b|vitest|jest|eslint|ruff|mypy|make\s+(test|check|build))/i;

/**
 * 只是把指令字串印出來，不是真的跑。
 * `echo "npm test"` 不能算驗證過——那是最廉價的偽造方式（codex 稽核抓到）。
 */
const ECHOED = /^\s*(echo|printf|print|cat|type|write-host|write-output)\b/i;

/** 「零失敗」的說法。這些出現時，不可以因為字面有 failed 就判成失敗。 */
const ZERO_FAIL = /\b0\s+(tests?\s+)?(failed|failing|failures|errors)\b|\ball tests? passed\b|\bno tests? failed\b/i;

/**
 * 沒有 exit code 可用時，從輸出文字判失敗。
 *
 * 刻意**不**比對裸的小寫 `failed`——`49 passed, 0 failed` 是最常見的成功輸出，
 * 舊版會把它判成失敗（2026-09-08 codex 稽核抓到，實測成立）。改成只認
 * 「非零個失敗」與明確的失敗標記。有 exit code 時一律以 exit code 為準。
 */
const FAIL_TEXT =
  /(\bFAIL\b|[1-9]\d*\s+(tests?\s+)?(failed|failing|failures)|not ok|error TS\d|AssertionError|exit code [1-9])/;

/**
 * 判定選項。`projectRoot` 是這套判定唯一的「範圍」概念。
 *
 * 為什麼需要它：2026-09-08 拿真實 transcript 實測時，閘門把寫到暫存目錄的一次性
 * 分析腳本（`D:\Temp\...\real-check.mjs`）當成專案程式碼而誤擋。那種腳本本來就
 * 沒有測試可跑，要求驗證是騷擾。給了 projectRoot 之後，只有工作目錄底下的修改
 * 才算數——ai-cli 這側傳 workFolder，plugin 這側傳 hook 事件的 cwd。
 */
export interface NormalizeOptions {
  projectRoot?: string | null;
}

/** Windows 磁碟機、UNC 或 POSIX 絕對路徑。 */
function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/**
 * 路徑正規化：統一斜線、解析掉 `.` 與 `..`、Windows 上去掉大小寫差異。
 *
 * `..` 必須真的解析，不能只做字面比對——否則 `C:\proj\..\outside\evil.ts`
 * 會因為字首是 `C:\proj` 而被當成專案內（2026-09-08 codex 稽核抓到）。
 * POSIX 檔案系統大小寫敏感，只在 win32 折疊大小寫。
 */
function canonical(path: string): string {
  const unified = path.replace(/\\/g, '/');
  const leadingSlash = unified.startsWith('/');
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else segments.push('..');
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
function insideProject(target: string, projectRoot?: string | null): boolean {
  if (!projectRoot) return true;
  const root = canonical(projectRoot);
  if (!root) return true;
  const file = canonical(isAbsolutePath(target) ? target : `${projectRoot}/${target}`);
  return file === root || file.startsWith(root + '/');
}

/** 從 shell 指令裡撈出看起來像檔案路徑的 token，用來判斷改的是不是專案內的檔案。 */
function pathTokens(command: string): string[] {
  return (command.match(/[^\s'"<>|&;()]+/g) ?? []).filter((token) => CODE_EXT.test(token));
}

/** 統一過的事件；不同 agent 的原始格式先正規化成這個形狀再判定。 */
export interface NormalizedEvent {
  kind: 'code_change' | 'verification' | 'other';
  /** 給人看的標籤，會出現在 evidence 裡。 */
  label: string;
  /** 只有 verification 有意義：true=通過、false=失敗。 */
  ok?: boolean;
}

function commandOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.script;
  return typeof command === 'string' ? command : '';
}

function pathOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const target = record.file_path ?? record.path ?? record.filePath ?? record.notebook_path;
  return typeof target === 'string' ? target : '';
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return '';
  const record = output as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => (part && typeof part === 'object' ? String((part as any).text ?? '') : String(part ?? '')))
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
export function normalizeToolEvent(entry: unknown, options: NormalizeOptions = {}): NormalizedEvent {
  if (!entry || typeof entry !== 'object') return { kind: 'other', label: '' };
  const record = entry as Record<string, unknown>;
  const tool = String(record.tool ?? record.name ?? '');
  const input = record.input;
  const command = commandOf(input);
  const target = pathOf(input);
  const { projectRoot } = options;

  if (EDIT_TOOL.test(tool) && target) {
    return CODE_EXT.test(target) && insideProject(target, projectRoot)
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
    const writesCode =
      SHELL_WRITE.test(command) &&
      pathTokens(command).some((token) => insideProject(token, projectRoot));
    if (writesCode) {
      return { kind: 'code_change', label: command.trim().slice(0, 160) };
    }
    if (VERIFY_CMD.test(command) && !ECHOED.test(command)) {
      const exitCode = record.exit_code ?? record.exitCode;
      const text = outputText(record.output);
      const ok =
        typeof exitCode === 'number'
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
export function classifyVerification(
  events: NormalizedEvent[],
  options: { structured?: boolean; waivedReason?: string | null } = {}
): VerificationReport {
  const { structured = true, waivedReason = null } = options;

  const lastChangeIndex = events.reduce(
    (found, event, index) => (event.kind === 'code_change' ? index : found),
    -1
  );
  const evidence: VerificationEvidence = {
    lastCodeChange: lastChangeIndex >= 0 ? events[lastChangeIndex].label : null,
    verificationsAfterChange: [],
    failedVerifications: [],
    staleVerifications: 0,
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.kind !== 'verification') continue;
    if (index < lastChangeIndex) {
      evidence.staleVerifications++;
      continue;
    }
    evidence.verificationsAfterChange.push(event.label);
    if (event.ok === false) evidence.failedVerifications.push(event.label);
  }

  if (!structured) {
    return {
      status: 'not_observed',
      reason:
        'this agent emits no structured tool history, so neither code changes nor verification could be observed — check the diff yourself before trusting this result',
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

  const stale =
    evidence.staleVerifications > 0
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
export function verificationFromAgentOutput(
  agentOutput: unknown,
  options: { structured?: boolean; waivedReason?: string | null; projectRoot?: string | null } = {}
): VerificationReport {
  const tools =
    agentOutput && typeof agentOutput === 'object'
      ? (agentOutput as Record<string, unknown>).tools
      : undefined;
  if (!Array.isArray(tools)) {
    return classifyVerification([], options);
  }
  // 注意不要寫成 tools.map(normalizeToolEvent)：map 會把 index 當第二參數傳進去。
  const projectRoot = options.projectRoot ?? null;
  return classifyVerification(
    tools.map((entry) => normalizeToolEvent(entry, { projectRoot })),
    options
  );
}
