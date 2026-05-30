/**
 * Agent 定義系統 — 整個框架「可擴充」的核心。
 *
 * 新增一個 AI agent = 新增一個 src/agents/<name>.ts 檔，實作 AgentDefinition，
 * 然後在 registry.ts 註冊。core/ 不需要任何改動。
 */

/** 所有已支援的 agent id。新增 agent 時在此加入字面量。 */
export type AgentId =
  | 'claude'
  | 'codex'
  | 'antigravity'
  | 'kiro'
  | 'forge'
  | 'opencode';

/** spawn 策略：決定 process-service 怎麼啟動這個 agent 的子程序。 */
export type SpawnMode =
  | 'pipe' // 一般 child_process.spawn + pipe（大多數 agent）
  | 'pty'; // Windows ConPTY（agy 之類在非 TTY 下不輸出的 CLI）

/** 由 agent.buildCommand() 產出，交給 process-service 執行。 */
export interface BuiltCommand {
  cliPath: string;
  args: string[];
  cwd: string;
  agent: AgentId;
  prompt: string;
  resolvedModel: string;
  /** 若為字串，prompt 透過 stdin（positional `-`）送入，而非當作 arg。 */
  stdinPrompt?: string;
}

/** buildCommand 的輸入。 */
export interface BuildCommandInput {
  cliPath: string;
  cwd: string;
  prompt: string;
  resolvedModel: string;
  rawModel: string;
  reasoningEffort: string;
  sessionId?: string;
  /** opencode 專用：oc-<provider/model> 解出的 provider/model。 */
  openCodeModel?: string | null;
}

/** CLI 二進位解析設定，交給共用的 binary-resolver 使用。 */
export interface BinaryConfig {
  /** 環境變數名稱，可覆寫 CLI 名稱或絕對路徑，例如 CLAUDE_CLI_NAME。 */
  envVarName: string;
  /** 預設指令名稱，例如 'claude'、'agy'、'kiro-cli'。 */
  defaultCliName: string;
  /** 可選的本機安裝絕對路徑（依平台），找得到就優先用。 */
  localInstallPath?: string;
}

/** reasoning_effort 支援度。 */
export interface ReasoningSupport {
  /** 此 agent 是否支援 reasoning_effort。 */
  supported: boolean;
  /** 允許的值集合（小寫）。supported 為 true 時必填。 */
  allowed?: ReadonlySet<string>;
  /** 不支援時拋出的錯誤訊息。 */
  unsupportedMessage?: string;
  /** 值不在 allowed 內時的錯誤訊息。 */
  invalidMessage?: string;
}

/**
 * 一個 AI agent 的完整定義。所有 agent 專屬行為都集中在這裡。
 */
export interface AgentDefinition {
  /** 唯一 id。 */
  id: AgentId;

  /** 此 agent 支援的標準 model 名稱清單。 */
  models: readonly string[];

  /**
   * 判斷一個（已解析 alias 後的）model 是否屬於此 agent。
   * registry 依序詢問各 agent；第一個回 true 的勝出。
   * claude 作為 fallback 永遠回 true，必須最後註冊。
   */
  matchesModel(resolvedModel: string): boolean;

  /** CLI 二進位解析設定。 */
  binary: BinaryConfig;

  /** reasoning_effort 支援度。 */
  reasoning: ReasoningSupport;

  /** 組裝實際 CLI 指令。 */
  buildCommand(input: BuildCommandInput): BuiltCommand;

  /** 解析此 agent 的原始 stdout/stderr 成結構化結果。 */
  parseOutput(stdout: string, stderr: string, exitCode?: number): unknown;

  /** 子程序啟動方式。預設 'pipe'。 */
  spawnMode?: SpawnMode;

  /**
   * Windows 上是否強制走某種 spawn。回傳的 mode 會覆寫 spawnMode。
   * 用於「只有 win32 才需要 PTY」這類情境（例如 agy）。
   */
  win32SpawnMode?: SpawnMode;

  /** opencode 失敗時保留 raw stdout/stderr（不靠 parser）。 */
  preserveRawOnFailure?: boolean;

  /**
   * Windows 上以 pipe spawn 時，是否「不」透過 cmd.exe shell 啟動。
   * 預設 false（多數 CLI 是 npm shim，win32 需要 shell:true 才能啟動）。
   * 設 true 用於真實 .exe（例如 kiro-cli.exe），避免 cmd.exe 對 prompt 重新切詞。
   */
  win32DirectExec?: boolean;
}
