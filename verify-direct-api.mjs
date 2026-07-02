// direct-api 基本驗證：mock fetch，不打真實 provider。
// 執行前需先 npm run build。
import assert from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessService } from './dist/core/process-service.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'aicli-direct-api-'));
const providersPath = join(tempRoot, 'providers.json');
writeFileSync(
  providersPath,
  JSON.stringify(
    {
      providers: {
        openrouter: {
          base_url: 'https://mock.openrouter.test/api/v1',
          api_key: 'test-key',
        },
      },
    },
    null,
    2
  )
);
process.env.AI_CLI_PROVIDERS_PATH = providersPath;

let capturedUrl = '';
let capturedBody = null;
let capturedAuthorization = '';

globalThis.fetch = async (url, init = {}) => {
  capturedUrl = String(url);
  capturedBody = JSON.parse(String(init.body));
  capturedAuthorization = String(init.headers.authorization || init.headers.Authorization || '');
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n' +
            'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
            'data: [DONE]\n\n'
        )
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
};

const service = new ProcessService({
  cliPaths: {
    claude: 'CLAUDE',
    codex: 'CODEX',
    antigravity: 'AGY',
    kiro: 'KIRO',
    forge: 'FORGE',
  },
});

const started = service.startProcess({
  workFolder: tempRoot,
  model: 'or-test/model',
  prompt: 'Say hello',
});

assert.strictEqual(started.agent, 'direct-api');
assert.strictEqual(started.status, 'started');

const [result] = await service.waitForProcesses([started.pid], 5, true);
assert.strictEqual(result.status, 'completed');
assert.strictEqual(result.exitCode, 0);
assert.strictEqual(result.agentOutput.message, 'Hello world');
assert.deepStrictEqual(result.agentOutput.tokens, { input: 3, output: 2, total: 5 });
assert.ok(result.session_id, 'session_id should be returned');
assert.ok(existsSync(result.agentOutput.sessionPath), 'session file should be written');

assert.strictEqual(capturedUrl, 'https://mock.openrouter.test/api/v1/chat/completions');
assert.strictEqual(capturedAuthorization, 'Bearer test-key');
assert.strictEqual(capturedBody.model, 'test/model');
assert.strictEqual(capturedBody.stream, true);
assert.deepStrictEqual(capturedBody.messages, [{ role: 'user', content: 'Say hello' }]);

console.log('PASS: direct-api mock fetch route/output/session verified');
