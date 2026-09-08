/**
 * Stop hook：改了程式碼卻沒跑驗證（或驗證失敗）就結束回應時，擋一次。
 *
 * 為什麼需要：2026-09-08 掃 178 條 transcript 量到，有改到程式碼的工作段裡
 * 31.7% 完全沒跑任何 test/build，而且比例隨上下文長度上升（0-200k 5%、600-800k 59%）。
 * 這跟省不省額度無關，是純粹的品質缺口，而且它會污染之後所有上下文/模型試點的結果——
 * 品質先變得可觀測，才有資格判斷別的改動有沒有傷到水平。
 *
 * 硬性規則（照 codex 稽核意見）：
 *   1. **一律 exit 0**。任何內部例外都靜默退出，絕不讓這支腳本弄壞使用者的 session。
 *   2. **最多擋一次**。官方輸入的 stop_hook_active 就是為了防無限迴圈；第二次一律放行。
 *   3. **判定用事件順序**。驗證必須發生在最後一次修改之後，否則「先跑測試再改程式碼」
 *      會假通過。
 *   4. **無法可靠判定時不擋**。讀不到 transcript、找不到判定模組，都直接放行。
 *
 * 已知限制：只看得到 transcript 裡的工具事件。若程式碼是被子行程間接改掉的（例如
 * 跑一支會自己改檔的腳本），這裡看不到，會回 not_applicable。這是刻意的取捨——
 * 寧可漏擋，也不要誤擋。
 */
import { readFileSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 只讀 transcript 尾端，避免每回合都掃幾十 MB。 */
const TAIL_BYTES = 4 * 1024 * 1024;
/** 與 file-process-service 同一個慣例，讓測試能隔離、不碰使用者目錄。 */
const STATE_DIR = process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
const LOG_PATH = join(STATE_DIR, 'verification-gate.jsonl');

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** 只讀檔案尾端，丟掉被切斷的第一行。 */
function readTail(path) {
  const size = statSync(path).size;
  const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
}

/**
 * 抽出「本回合」的工具事件：從尾端往回找最後一則真正的使用者輸入，取其後的 tool_use。
 * tool_result 也掛在 role:user 上，必須排除，否則會誤判回合邊界。
 */
function currentTurnEvents(transcriptPath) {
  const lines = readTail(transcriptPath).split('\n');
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* 半行或壞行，跳過 */
    }
  }
  let turnStart = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const message = parsed[i].message;
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    const isToolResult = Array.isArray(content) && content.some((p) => p && p.type === 'tool_result');
    if (isToolResult) continue;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n')
          : '';
    if (/\[Request interrupted by user/.test(text)) continue;
    turnStart = i;
    break;
  }

  // tool_use 與其結果分屬不同行，先收 tool_use 再用 tool_result 補上輸出。
  const events = [];
  const byId = new Map();
  for (let i = turnStart; i < parsed.length; i++) {
    const message = parsed[i].message;
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use') {
        const entry = { tool: part.name, input: part.input, output: null };
        events.push(entry);
        if (part.id) byId.set(part.id, entry);
      } else if (part.type === 'tool_result' && part.tool_use_id) {
        const entry = byId.get(part.tool_use_id);
        if (!entry) continue;
        entry.output = part.content;
        // Claude Code 用 is_error 表示指令失敗；轉成 exit_code 讓判定模組優先採用。
        if (part.is_error === true) entry.exit_code = 1;
      }
    }
  }
  return events;
}

function record(entry) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(
      LOG_PATH,
      JSON.stringify({ at: new Date().toISOString(), source: 'hook', ...entry }) + '\n'
    );
  } catch {
    /* 記錄失敗不能影響判定 */
  }
}

/** 讀 ai-cli 寫下的安裝位置；讀不到就回 null。 */
function installedAiCliRoot() {
  try {
    const raw = readFileSync(join(STATE_DIR, 'install.json'), 'utf8');
    const root = JSON.parse(raw)?.repoRoot;
    return typeof root === 'string' && root ? root : null;
  } catch {
    return null;
  }
}

async function loadClassifier() {
  /*
    先用 ai-cli 安裝裡的那份，再退回 plugin 自帶的。

    Claude Code 安裝 plugin 是把 source 目錄**複製**到 cache，之後 git pull 不會
    動它——2026-09-08 連續三次被自己的閘門誤擋，就是因為判定修好了、push 了，
    本機仍跑安裝當下複製的那份，而且要重裝才會生效（重裝完又被下一次修改超車）。

    所以有裝 ai-cli 的機器直接讀它的 dist，跟著自動更新前進，不必重裝 plugin；
    沒裝的機器才用自帶的 verification-core.mjs（那份由 build 同步並進版控，
    保證 marketplace 安裝後仍然能運作）。
  */
  const root = installedAiCliRoot();
  if (root) {
    try {
      return await import(pathToFileURL(join(root, 'dist', 'core', 'verification.js')).href);
    } catch {
      /* 那份不能用就退回自帶的 */
    }
  }
  try {
    return await import(pathToFileURL(join(HERE, 'verification-core.mjs')).href);
  } catch {
    return null;
  }
}

async function main() {
  let event;
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    return;
  }

  const transcript = event.transcript_path;
  if (!transcript) return;

  let events;
  try {
    events = currentTurnEvents(transcript);
  } catch {
    return; // 讀不到 transcript 就不擋
  }
  if (events.length === 0) return;

  const mod = await loadClassifier();
  if (!mod?.classifyVerification || !mod?.normalizeToolEvent) return;

  // cwd 是這個回合的專案根。少了它，寫到暫存目錄的一次性分析腳本會被當成專案
  // 程式碼而誤擋——2026-09-08 拿真實 transcript 實測時就是這樣被抓到的。
  // 也不要寫成 events.map(mod.normalizeToolEvent)：map 會把 index 當第二參數傳進去。
  const projectRoot = event.cwd ?? null;
  const report = mod.classifyVerification(
    events.map((entry) => mod.normalizeToolEvent(entry, { projectRoot })),
    { structured: true }
  );

  /*
    該擋的兩種情況：改了程式碼卻沒驗證，或驗證跑了而且失敗。

    舊版只擋前者，理由是「失敗時模型自己看得到」。但那正是完成閘門要防的事——
    模型看得到失敗，仍然可能回一句「改好了」就結束（2026-09-08 codex 稽核指出
    「這不是完成閘門」）。所以驗證失敗也擋一次。
  */
  const shouldBlock =
    (report.status === 'not_observed' || report.status === 'failed') &&
    !!report.evidence.lastCodeChange;

  if (!shouldBlock) {
    if (report.evidence.lastCodeChange) {
      record({ session: event.session_id, status: report.status, gate: 'allow' });
    }
    return;
  }

  /*
    第二次一律放行。stop_hook_active 是官方用來防無限迴圈的旗標。

    這裡**不記成 waived**：waived 的定義是「有明確記錄的豁免理由」，而 hook 沒有
    可靠的方法判斷模型是否真的寫了理由——照記 waived 會讓紀錄說謊
    （2026-09-08 codex 稽核抓到）。誠實記下原狀態，只標明是擋過之後放行的。
  */
  if (event.stop_hook_active) {
    record({
      session: event.session_id,
      status: report.status,
      gate: 'allow-after-block',
      lastCodeChange: report.evidence.lastCodeChange,
    });
    return;
  }

  record({
    session: event.session_id,
    status: report.status,
    gate: 'block',
    lastCodeChange: report.evidence.lastCodeChange,
    stale: report.evidence.staleVerifications,
  });

  const failedList = report.evidence.failedVerifications.map((v) => '  - ' + v).join('\n');
  const stale =
    report.evidence.staleVerifications > 0
      ? '（有 ' + report.evidence.staleVerifications + ' 次驗證跑在這次修改之前，不算數）'
      : '';
  const reason =
    report.status === 'failed'
      ? '這個回合改到了程式碼（最後一次：' + report.evidence.lastCodeChange + '），' +
        '而修改之後跑的驗證失敗了：\n' + failedList + '\n' +
        '請修到通過再結束，或明確寫出「為什麼這個失敗可以先不處理」。\n' +
        '這個閘門只會擋一次，第二次一律放行。'
      : '這個回合改到了程式碼（最後一次：' + report.evidence.lastCodeChange + '），' +
        '但修改之後沒有跑過任何測試或建置' + stale + '。\n' +
        '請擇一完成後再結束：\n' +
        '1. 跑這個專案對應的驗證（測試 / 建置 / 型別檢查），並回報結果；\n' +
        '2. 若這個改動確實無法驗證（例如專案沒有測試框架、或改的是無法自動驗證的部分），' +
        '明確寫出一句「不驗證的理由」再結束。\n' +
        '這個閘門只會擋一次，第二次一律放行。';

  // 用 callback 等 stdout 真的寫出去再退出；立刻 process.exit 可能截斷輸出。
  await new Promise((resolve) => {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }), () => resolve());
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
