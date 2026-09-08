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

/** 直接改檔的工具。 */
const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/i;

/** shell 裡也能改程式碼：重導向、sed -i、tee、patch、mv/cp 到程式碼檔。 */
const SHELL_WRITE =
  /(^|[\s;&|])(sed\s+(-[^\s]*\s+)*-i|patch\s|tee\s|dd\s+of=|install\s+-D)|>\s*[^\s>|&]+|>>\s*[^\s>|&]+|\b(mv|cp)\s+[^\s]+\s+[^\s]+/i;

/** 跑得起來就算驗證的指令。跟 baseline 腳本用同一套，換掉要兩邊一起換。 */
const VERIFY_CMD =
  /(npm\s+(run\s+)?(test|build|lint|typecheck)|yarn\s+(test|build|lint)|pnpm\s+(test|build|lint)|npx\s+(tsc|vitest|jest|eslint)|pytest|python\s+-m\s+pytest|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|dotnet\s+(test|build)|mvn\s+(test|verify)|gradle\s+(test|build)|\btsc\b|vitest|jest|eslint|ruff|mypy|make\s+(test|check|build))/i;

/** 沒有 exit code 可用時，從輸出文字判失敗。寧可誤判成 failed 也不要誤判成 passed。 */
const FAIL_TEXT =
  /(\bFAIL\b|\bfailed\b|\bfailing\b|not ok|error TS\d|\bError:|AssertionError|\d+ (test(s)? )?failed|exit code [1-9])/i;

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
export function normalizeToolEvent(entry: unknown): NormalizedEvent {
  if (!entry || typeof entry !== 'object') return { kind: 'other', label: '' };
  const record = entry as Record<string, unknown>;
  const tool = String(record.tool ?? record.name ?? '');
  const input = record.input;
  const command = commandOf(input);
  const target = pathOf(input);

  if (EDIT_TOOL.test(tool) && target) {
    return CODE_EXT.test(target)
      ? { kind: 'code_change', label: `${tool} ${target}` }
      : { kind: 'other', label: `${tool} ${target}` };
  }

  if (command) {
    if (VERIFY_CMD.test(command)) {
      const exitCode = record.exit_code ?? record.exitCode;
      const ok =
        typeof exitCode === 'number' ? exitCode === 0 : !FAIL_TEXT.test(outputText(record.output));
      return { kind: 'verification', label: command.trim().slice(0, 160), ok };
    }
    if (SHELL_WRITE.test(command) && CODE_EXT.test(command)) {
      return { kind: 'code_change', label: command.trim().slice(0, 160) };
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
 * 從 agent 的 `tools` 陣列直接產出報告。`tools` 為 undefined 代表 parser 沒抽到東西
 * （agy 一律如此），這跟「有紀錄但裡面沒有驗證」必須分開回報。
 */
export function verificationFromAgentOutput(
  agentOutput: unknown,
  options: { structured?: boolean; waivedReason?: string | null } = {}
): VerificationReport | null {
  const tools =
    agentOutput && typeof agentOutput === 'object'
      ? (agentOutput as Record<string, unknown>).tools
      : undefined;
  if (!Array.isArray(tools)) {
    return options.structured === false
      ? classifyVerification([], options)
      : null;
  }
  return classifyVerification(tools.map(normalizeToolEvent), options);
}
