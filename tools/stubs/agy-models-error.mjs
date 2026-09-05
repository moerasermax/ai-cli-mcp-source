#!/usr/bin/env node
/** 本機重現 eligibility 失敗；前置空行驗證診斷取第一行非空文字。 */
console.error('\nError: Eligibility check failed: stub network unavailable\nsecondary diagnostic');
process.exitCode = 1;
