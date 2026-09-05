/** alias 舊測試及突變 harness 的查詢隔離；不改使用者快取、不連真實 vendor。 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 不預先實體化 node:fs 的 ESM facade，保留 verify-alias-config 的讀取注入能力。
const fs = createRequire(import.meta.url)('node:fs');
const temp = fs.mkdtempSync(join(tmpdir(), 'ai-cli-catalog-tests-'));
const stub = fileURLToPath(new URL(process.platform === 'win32'
  ? './agy-models-error.cmd' : './agy-models-error.mjs', import.meta.url));
if (process.platform !== 'win32') fs.chmodSync(stub, 0o755);
process.env.AI_CLI_CATALOG_CACHE_PATH = join(temp, 'catalog-cache.json');
process.env.AGY_CLI_NAME = stub;
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
