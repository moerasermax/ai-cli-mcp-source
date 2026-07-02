// direct-api 基本驗證：mock fetch，不打真實 provider。
// 執行前需先 npm run build。
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
writeFileSync(
  join(tempRoot, 'package.json'),
  JSON.stringify({ name: 'mock-package', version: '9.9.9' }, null, 2)
);
process.env.AI_CLI_PROVIDERS_PATH = providersPath;

let capturedUrl = '';
const capturedBodies = [];
let capturedAuthorization = '';
const xmlReportPath = '.tmp/plan027_qwen_tool_test.md';
const xmlReportContent = '# Report content here\n\nGenerated through XML fallback.';
const xmlReportOutputPreview = `Wrote ${xmlReportContent.length} chars to ${join('.tmp', 'plan027_qwen_tool_test.md')}.`;

function streamResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

globalThis.fetch = async (url, init = {}) => {
  capturedUrl = String(url);
  const requestBody = JSON.parse(String(init.body));
  capturedBodies.push(requestBody);
  capturedAuthorization = String(init.headers.authorization || init.headers.Authorization || '');
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const firstUser = messages.find((message) => message?.role === 'user');
  const firstUserContent = typeof firstUser?.content === 'string' ? firstUser.content : '';

  if (firstUserContent === 'Read package.json and tell me the version' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read',
                  type: 'function',
                  function: { name: 'read_file', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"path":"package.json"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
  }
  if (messages.some((message) => message?.tool_call_id === 'call_read')) {
    return streamResponse([
      { choices: [{ delta: { content: 'Version ' } }] },
      { choices: [{ delta: { content: '9.9.9' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ]);
  }
  if (firstUserContent === 'Write XML fallback report' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      {
        choices: [
          {
            delta: {
              content: `<tool_call>
<function=write_file>
<parameter=path>${xmlReportPath}</parameter>
<parameter=content>
${xmlReportContent}
</parameter>
</function>
</tool_call>`,
            },
            finish_reason: 'stop',
          },
        ],
      },
      { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]);
  }
  if (messages.some((message) => message?.tool_call_id === 'xml_call_0')) {
    return streamResponse([
      { choices: [{ delta: { content: 'XML fallback wrote report' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } },
    ]);
  }
  return streamResponse([
    { choices: [{ delta: { content: 'Hello without tools' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
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
  prompt: 'Read package.json and tell me the version',
});

assert.strictEqual(started.agent, 'direct-api');
assert.strictEqual(started.status, 'started');

const [result] = await service.waitForProcesses([started.pid], 5, true);
assert.strictEqual(result.status, 'completed');
assert.strictEqual(result.exitCode, 0);
assert.strictEqual(result.agentOutput.message, 'Version 9.9.9');
assert.deepStrictEqual(result.agentOutput.tokens, { input: 7, output: 3, total: 10 });
assert.deepStrictEqual(result.agentOutput.tools, [
  {
    tool: 'read_file',
    input: { path: 'package.json' },
    status: 'completed',
    output_preview: '{\n  "name": "mock-package",\n  "version": "9.9.9"\n}',
  },
]);
assert.ok(result.session_id, 'session_id should be returned');
assert.ok(existsSync(result.agentOutput.sessionPath), 'session file should be written');

assert.strictEqual(capturedUrl, 'https://mock.openrouter.test/api/v1/chat/completions');
assert.strictEqual(capturedAuthorization, 'Bearer test-key');
assert.strictEqual(capturedBodies.length, 2);
assert.strictEqual(capturedBodies[0].model, 'test/model');
assert.strictEqual(capturedBodies[0].stream, true);
assert.ok(capturedBodies[0].tools.some((tool) => tool.function?.name === 'read_file'));
assert.deepStrictEqual(capturedBodies[0].messages, [
  { role: 'user', content: 'Read package.json and tell me the version' },
]);
assert.strictEqual(capturedBodies[1].messages[1].role, 'assistant');
assert.deepStrictEqual(capturedBodies[1].messages[1].tool_calls, [
  {
    id: 'call_read',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"package.json"}' },
  },
]);
assert.strictEqual(capturedBodies[1].messages[2].role, 'tool');
assert.strictEqual(capturedBodies[1].messages[2].tool_call_id, 'call_read');
assert.ok(capturedBodies[1].messages[2].content.includes('"version": "9.9.9"'));

const savedSession = JSON.parse(readFileSync(result.agentOutput.sessionPath, 'utf-8'));
assert.deepStrictEqual(savedSession.messages.map((message) => message.role), [
  'user',
  'assistant',
  'tool',
  'assistant',
]);

const noToolsStarted = service.startProcess({
  workFolder: tempRoot,
  model: 'or-test/model',
  prompt: '[no-tools] Say hello without tools',
});
const [noToolsResult] = await service.waitForProcesses([noToolsStarted.pid], 5, true);
assert.strictEqual(noToolsResult.status, 'completed');
assert.strictEqual(capturedBodies.length, 3);
assert.strictEqual(capturedBodies[2].tools, undefined);
assert.deepStrictEqual(capturedBodies[2].messages, [
  { role: 'user', content: 'Say hello without tools' },
]);

const xmlStarted = service.startProcess({
  workFolder: tempRoot,
  model: 'or-test/model',
  prompt: 'Write XML fallback report',
});
const [xmlResult] = await service.waitForProcesses([xmlStarted.pid], 5, true);
assert.strictEqual(xmlResult.status, 'completed');
assert.strictEqual(xmlResult.exitCode, 0);
assert.strictEqual(xmlResult.agentOutput.message, 'XML fallback wrote report');
assert.deepStrictEqual(xmlResult.agentOutput.tools, [
  {
    tool: 'write_file',
    input: { path: xmlReportPath, content: xmlReportContent },
    status: 'completed',
    output_preview: xmlReportOutputPreview,
  },
]);
assert.strictEqual(readFileSync(join(tempRoot, xmlReportPath), 'utf-8'), xmlReportContent);
assert.strictEqual(capturedBodies.length, 5);
assert.deepStrictEqual(capturedBodies[4].messages[1], {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'xml_call_0',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: xmlReportPath, content: xmlReportContent }),
      },
    },
  ],
});
assert.strictEqual(capturedBodies[4].messages[2].role, 'tool');
assert.strictEqual(capturedBodies[4].messages[2].tool_call_id, 'xml_call_0');
assert.ok(capturedBodies[4].messages[2].content.includes(`Wrote ${xmlReportContent.length} chars`));

console.log('PASS: direct-api mock fetch route/output/session verified');
