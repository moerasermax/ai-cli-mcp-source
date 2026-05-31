/**
 * Usage service — 查詢各 CLI agent 剩餘 token/quota。
 * 支援 Kiro（pipe）、Claude、Codex、agy（PTY）。
 * 結果快取 120 秒，error 快取 30 秒。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { stripAnsi } from '../core/ansi.js';

const _patchRequire = createRequire(import.meta.url);
let _ptyModule: any = null;

function _loadPtyModule(): any {
  if (_ptyModule) return _ptyModule;
  _ptyModule = _patchRequire('@homebridge/node-pty-prebuilt-multiarch');
  return _ptyModule;
}

function _cleanUsageText(text: string): string {
  return stripAnsi(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function _toNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function _toBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['enabled', 'enable', 'on', 'true', 'yes'].includes(normalized)) return true;
  if (['disabled', 'disable', 'off', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function _extractFirstNumber(text: string, regex: RegExp): number | null {
  const match = text.match(regex);
  return match ? _toNumber(match[1]) : null;
}

function _extractLooseNumbers(text: string): number[] {
  const matches = text.match(/(?<![\w.-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w.-])/g) ?? [];
  return matches.map((v) => _toNumber(v)).filter((v): v is number => v !== null);
}

function _parseLooseUsage(text: string): Record<string, unknown> {
  const raw = _cleanUsageText(text);
  const usage: Record<string, unknown> = { raw };
  const resetDate = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const percentUsed = _extractFirstNumber(raw, /(\d+(?:\.\d+)?)\s*%/);
  const costUsd = _extractFirstNumber(raw, /(?:est\.?\s*)?cost[^$\d]*(?:\$|USD\s*)?([\d,.]+)/i);
  const numbers = _extractLooseNumbers(raw);
  if (resetDate) usage.resetDate = resetDate[1];
  if (percentUsed !== null) usage.percentUsed = percentUsed;
  if (costUsd !== null) usage.costUsd = costUsd;
  if (numbers.length > 0) usage.numbers = numbers;
  return usage;
}

export function parseKiroUsage(text: string) {
  const raw = _cleanUsageText(text);
  const creditsMatch = raw.match(/Credits\s*\(\s*([\d,.]+)\s+of\s+([\d,.]+)(?:\s+[^)]*)?\)/i);
  const fallbackMatch = raw.match(/Credits\s+used:\s*([\d,.]+)/i);
  const resetDateMatch = raw.match(/resets?\s+on\s+(\d{4}-\d{2}-\d{2})/i);
  const overagesMatch = raw.match(/Overages:\s*(Enabled|Disabled|On|Off|True|False|Yes|No)/i);
  const costMatch = raw.match(/Est\.?\s*cost:\s*(?:\$|USD\s*)?([\d,.]+)\s*(?:USD)?/i);
  const percentUsed = _extractFirstNumber(raw, /(\d+(?:\.\d+)?)\s*%/);
  return {
    creditsUsed: creditsMatch ? _toNumber(creditsMatch[1]) : (fallbackMatch ? _toNumber(fallbackMatch[1]) : null),
    creditsTotal: creditsMatch ? _toNumber(creditsMatch[2]) : null,
    percentUsed,
    resetDate: resetDateMatch ? resetDateMatch[1] : null,
    overagesEnabled: overagesMatch ? _toBoolean(overagesMatch[1]) : null,
    costUsd: costMatch ? _toNumber(costMatch[1]) : null,
  };
}

export function parseClaudeUsage(text: string) {
  const raw = _cleanUsageText(text);
  // 移除進度條方塊字元，讓 regex 易於匹配
  const s = raw.replace(/[█▌▎▍▋▊▉▏▐▀▄■□▪▫]+/g, ' ');

  const sessionPct     = _extractFirstNumber(s, /Current\s+session\s+(\d+(?:\.\d+)?)\s*%/i);
  const sessionReset   = s.match(/Current\s+session\s+[\d\s%used]+Rese[st]+\s+([^\n]+?)(?=Current|\n|$)/i)?.[1]?.trim() ?? null;
  const weekAllPct     = _extractFirstNumber(s, /Current\s+week\s*\(?all\s+models\)?\s+(\d+(?:\.\d+)?)\s*%/i);
  const weekAllReset   = s.match(/Current\s+week\s*\(?all\s+models\)?\s+[\d\s%used]+Resets?\s+([^\n]+?)(?=Current|\n|$)/i)?.[1]?.trim() ?? null;
  const weekSonnetPct  = _extractFirstNumber(s, /Current\s+week\s*\(?Sonnet\s+only\)?\s+(\d+(?:\.\d+)?)\s*%/i);
  const weekSonnetReset= s.match(/Current\s+week\s*\(?Sonnet\s+only\)?\s+[\d\s%used]+Resets?\s+([^\n]+?)(?=What|\n|$)/i)?.[1]?.trim() ?? null;
  const costUsd        = _extractFirstNumber(s, /Session\s+cost:\s*\$?([\d,.]+)/i);
  const inputTokens    = _extractFirstNumber(s, /(\d+)\s+input/i);
  const outputTokens   = _extractFirstNumber(s, /(\d+)\s+output/i);
  const cacheRead      = _extractFirstNumber(s, /(\d+)\s+cache\s+read/i);
  const cacheWrite     = _extractFirstNumber(s, /(\d+)\s+cache\s+write/i);

  return {
    raw,
    sessionPercent:        sessionPct,
    sessionResetAt:        sessionReset,
    weekAllModelsPercent:  weekAllPct,
    weekAllModelsResetAt:  weekAllReset,
    weekSonnetPercent:     weekSonnetPct,
    weekSonnetResetAt:     weekSonnetReset,
    sessionCostUsd:        costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens:       cacheRead,
    cacheWriteTokens:      cacheWrite,
  };
}

export function parseCodexUsage(text: string) {
  try { return _parseLooseUsage(text); } catch { return { raw: _cleanUsageText(text) }; }
}

export function parseAgyUsage(text: string) {
  const raw = _cleanUsageText(text);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const models: { model: string; percentUsed: number | null; status: string | null }[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1] ?? '';
    const percentMatch = next.match(/(\d+(?:\.\d+)?)\s*%\s*$/);
    if (!percentMatch) continue;
    const nameLine = lines[i];
    if (/^[─═\-=│|>◉]+$/.test(nameLine)) continue;
    if (/↑|↓|pgup|pgdown|ctrl|esc/i.test(nameLine)) continue;
    if (/^\(\d+/.test(nameLine)) continue;
    const statusLine = lines[i + 2] ?? '';
    const isNav = /↑|↓|pgup|pgdown|ctrl|esc/i.test(statusLine);
    models.push({ model: nameLine, percentUsed: _toNumber(percentMatch[1]), status: (!isNav && statusLine) ? statusLine : null });
    i += 2;
  }

  if (models.length > 0) return { type: 'model_quota', models, raw };
  try { return { ...(_parseLooseUsage(raw)), type: 'raw' }; }
  catch { return { type: 'raw', raw }; }
}

// ─── providers ───────────────────────────────────────────────────────────────

interface PtyRunResult { output: string; exitCode: number | null; signal: string | null; timedOut: boolean }
interface PipeRunResult { stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean }

class KiroUsageProvider {
  provider = 'kiro';
  transport = 'pipe';
  constructor(private cliPath: string) {}

  async query() {
    const result = await this._run();
    const text = _cleanUsageText(result.stderr || result.stdout);
    if (!text) throw new Error(`Kiro usage: no output (exit ${result.exitCode ?? 'null'})`);
    return parseKiroUsage(text);
  }

  private _run(): Promise<PipeRunResult> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.cliPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      } catch (e) { reject(e); return; }

      let stdout = '', stderr = '', timedOut = false, settled = false;
      let writeT: ReturnType<typeof setTimeout> | null = null;
      let timeoutT: ReturnType<typeof setTimeout> | null = null;
      let forceT: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => { if (writeT) clearTimeout(writeT); if (timeoutT) clearTimeout(timeoutT); if (forceT) clearTimeout(forceT); };
      const ok = (v: PipeRunResult) => { if (settled) return; settled = true; cleanup(); resolve(v); };
      const fail = (e: unknown) => { if (settled) return; settled = true; cleanup(); reject(e); };

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.stdin?.on('error', () => {});
      child.on('error', fail);
      child.on('close', (code, sig) => ok({ stdout, stderr, exitCode: code, signal: sig, timedOut }));

      writeT = setTimeout(() => { try { child.stdin?.write('/usage\n'); child.stdin?.end(); } catch {} }, 500);
      timeoutT = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
        forceT = setTimeout(() => ok({ stdout, stderr, exitCode: null, signal: null, timedOut }), 1500);
      }, 10_000);
    });
  }
}

class PtyUsageProvider {
  transport = 'pty';
  constructor(
    public provider: string,
    private cliPath: string,
    private command: string,
    private parser: (text: string) => unknown,
  ) {}

  async query() {
    const result = await this._run();
    const text = _cleanUsageText(result.output);
    if (!text) throw new Error(`${this.provider} usage: no output`);
    return this.parser(text);
  }

  private _run(): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      let ptyProc: any;
      try {
        const pty = _loadPtyModule();
        ptyProc = pty.spawn(this.cliPath, [], { name: 'xterm-color', cols: 200, rows: 50, cwd: process.cwd(), env: process.env });
      } catch (e) { reject(e); return; }
      if (!ptyProc?.pid) { reject(new Error(`${this.provider} pty.spawn returned no pid`)); return; }

      let output = '', timedOut = false, settled = false;
      let writeT: ReturnType<typeof setTimeout> | null = null;
      let killT: ReturnType<typeof setTimeout> | null = null;
      let forceT: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => { if (writeT) clearTimeout(writeT); if (killT) clearTimeout(killT); if (forceT) clearTimeout(forceT); };
      const settle = (v: PtyRunResult) => { if (settled) return; settled = true; cleanup(); resolve(v); };

      ptyProc.onData((d: string) => { output += d; });
      ptyProc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => settle({ output, exitCode, signal, timedOut }));

      writeT = setTimeout(() => { try { ptyProc.write(this.command); } catch {} }, 1500);
      killT = setTimeout(() => {
        timedOut = true;
        try { ptyProc.kill(); } catch {}
        forceT = setTimeout(() => settle({ output, exitCode: null, signal: null, timedOut }), 1500);
      }, 6500);
    });
  }
}

class AgyUsageProvider {
  provider = 'agy';
  transport = 'pty';
  constructor(private cliPath: string) {}

  async query() {
    const result = await this._run();
    const text = _cleanUsageText(result.output);
    if (!text) throw new Error('agy usage: no output');
    return parseAgyUsage(text);
  }

  private _run(): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      let ptyProc: any;
      try {
        const pty = _loadPtyModule();
        ptyProc = pty.spawn(this.cliPath, ['--dangerously-skip-permissions'], { name: 'xterm-color', cols: 220, rows: 50, cwd: process.cwd(), env: process.env });
      } catch (e) { reject(e); return; }
      if (!ptyProc?.pid) { reject(new Error('agy pty.spawn returned no pid')); return; }

      let output = '', timedOut = false, settled = false, commandSent = false;
      let captureT: ReturnType<typeof setTimeout> | null = null;
      let hardKillT: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => { if (captureT) clearTimeout(captureT); if (hardKillT) clearTimeout(hardKillT); };
      const settle = (v: PtyRunResult) => {
        if (settled) return; settled = true; cleanup();
        try { ptyProc.kill(); } catch {}
        resolve(v);
      };

      hardKillT = setTimeout(() => { timedOut = true; settle({ output, exitCode: null, signal: null, timedOut }); }, 20_000);

      ptyProc.onData((data: string) => {
        output += data;
        if (!commandSent && output.includes('? for shortcuts')) {
          commandSent = true;
          setTimeout(() => {
            try { ptyProc.write('/usage\r'); } catch {}
            const poll = () => {
              if (output.includes('Model Quota') || output.includes('Quota available')) {
                if (captureT) clearTimeout(captureT);
                captureT = setTimeout(() => settle({ output, exitCode: null, signal: null, timedOut: false }), 2000);
              } else {
                captureT = setTimeout(poll, 250);
              }
            };
            captureT = setTimeout(poll, 500);
          }, 800);
        }
      });

      ptyProc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => settle({ output, exitCode, signal, timedOut }));
    });
  }
}

class ClaudeUsageProvider {
  provider = 'claude';
  transport = 'pty';
  constructor(private cliPath: string) {}

  async query() {
    const result = await this._run();
    const text = _cleanUsageText(result.output);
    if (!text) throw new Error('claude usage: no output');
    return parseClaudeUsage(text);
  }

  private _run(): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      let ptyProc: any;
      try {
        const pty = _loadPtyModule();
        ptyProc = pty.spawn(this.cliPath, [], { name: 'xterm-color', cols: 200, rows: 50, cwd: process.cwd(), env: process.env });
      } catch (e) { reject(e); return; }
      if (!ptyProc?.pid) { reject(new Error('claude pty.spawn returned no pid')); return; }

      let output = '', timedOut = false, settled = false, commandSent = false;
      let captureT: ReturnType<typeof setTimeout> | null = null;
      let hardKillT: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => { if (captureT) clearTimeout(captureT); if (hardKillT) clearTimeout(hardKillT); };
      const settle = (v: PtyRunResult) => {
        if (settled) return; settled = true; cleanup();
        try { ptyProc.kill(); } catch {}
        resolve(v);
      };

      hardKillT = setTimeout(() => { timedOut = true; settle({ output, exitCode: null, signal: null, timedOut }); }, 25_000);

      ptyProc.onData((data: string) => {
        output += data;
        // 等 Claude Code prompt 出現後才送 /usage
        if (!commandSent && output.includes('❯')) {
          commandSent = true;
          setTimeout(() => {
            try { ptyProc.write('/usage\r'); } catch {}
            // 等輸出包含 usage 相關內容後再截取
            const poll = () => {
              const cleaned = _cleanUsageText(output);
              const hasUsage = /session|token|usage|remaining|plan|limit/i.test(cleaned);
              // 等第二個 ❯ 出現（代表 /usage 輸出完畢，prompt 回來了）
              const promptCount = (output.match(/❯/g) ?? []).length;
              if (hasUsage && promptCount >= 2) {
                if (captureT) clearTimeout(captureT);
                captureT = setTimeout(() => settle({ output, exitCode: null, signal: null, timedOut: false }), 500);
              } else {
                captureT = setTimeout(poll, 250);
              }
            };
            captureT = setTimeout(poll, 500);
          }, 500);
        }
      });

      ptyProc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => settle({ output, exitCode, signal, timedOut }));
    });
  }
}

// ─── UsageService ─────────────────────────────────────────────────────────────

export interface UsageCliPaths {
  kiro?: string;
  claude?: string;
  codex?: string;
  antigravity?: string;
}

const ALL_AGENTS = ['kiro', 'claude', 'codex', 'agy'] as const;
type AgentKey = typeof ALL_AGENTS[number];
const DEFAULT_TTL = 120_000;
const NEG_TTL = 30_000;

function _norm(agent: string): string {
  return agent === 'antigravity' ? 'agy' : agent;
}

function _cacheInfo(hit: boolean, ageMs: number, ttlMs: number) {
  return { hit, ageSeconds: Math.max(0, Math.floor(ageMs / 1000)), ttlSeconds: Math.round(ttlMs / 1000) };
}

function _makeResult(provider: string, status: string, usage: unknown, error: string | null, ttlMs: number) {
  return { provider, transport: provider === 'kiro' ? 'pipe' : 'pty', status, cache: _cacheInfo(false, 0, ttlMs), usage, error };
}

function _errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class UsageService {
  private cache = new Map<string, { result: ReturnType<typeof _makeResult>; capturedAt: number; ttlMs: number }>();
  private inflight = new Map<string, Promise<ReturnType<typeof _makeResult>>>();
  private providers: Map<string, { query(): Promise<unknown> }>;

  constructor(cliPaths: UsageCliPaths = {}) {
    const entries: [string, { query(): Promise<unknown> }][] = [
      ['kiro',   new KiroUsageProvider(cliPaths.kiro ?? '')],
      ['claude', new ClaudeUsageProvider(cliPaths.claude ?? '')],
      ['codex',  new PtyUsageProvider('codex', cliPaths.codex ?? '', '/status\r', parseCodexUsage)],
      ['agy',    new AgyUsageProvider(cliPaths.antigravity ?? '')],
    ];
    this.providers = new Map(entries);
  }

  async queryAll({ agents, refresh = false }: { agents?: string[]; refresh?: boolean } = {}) {
    const selected = (agents?.length ? agents.map(_norm) : [...ALL_AGENTS]) as string[];
    const providers = await Promise.all(selected.map((a) => this.queryProvider(a, { refresh })));
    return { ok: true, capturedAt: new Date().toISOString(), providers };
  }

  async queryProvider(agent: string, { refresh = false } = {}): Promise<ReturnType<typeof _makeResult>> {
    const key = _norm(agent);
    if (!(ALL_AGENTS as readonly string[]).includes(key)) {
      return _makeResult(key, 'unavailable', null, `Unknown provider: ${agent}`, NEG_TTL);
    }
    if (!refresh) {
      const cached = this.cache.get(key);
      if (cached) {
        const age = Date.now() - cached.capturedAt;
        if (age < cached.ttlMs) return { ...cached.result, cache: _cacheInfo(true, age, cached.ttlMs) };
      }
    }
    const inFlight = this.inflight.get(key);
    if (inFlight) return inFlight;

    const p = this._queryUncached(key).then((result) => {
      const ttl = result.status === 'ok' ? DEFAULT_TTL : NEG_TTL;
      const r = { ...result, cache: _cacheInfo(false, 0, ttl) };
      this.cache.set(key, { result: r, capturedAt: Date.now(), ttlMs: ttl });
      return r;
    }).finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  private async _queryUncached(agent: string): Promise<ReturnType<typeof _makeResult>> {
    const provider = this.providers.get(agent);
    if (!provider) return _makeResult(agent, 'unavailable', null, `${agent} CLI not configured`, NEG_TTL);
    try {
      const usage = await provider.query();
      return _makeResult(agent, 'ok', usage, null, DEFAULT_TTL);
    } catch (e) {
      return _makeResult(agent, 'error', null, _errMsg(e), NEG_TTL);
    }
  }
}

export function createUsageService(cliPaths: UsageCliPaths): UsageService {
  return new UsageService(cliPaths);
}
