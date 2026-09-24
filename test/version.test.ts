// 客户端版本单一来源测试：CLIENT_VERSION 与 package.json 的 version 同源
// （构建时由 tsup/vitest 的 define 注入，杜绝两处手写漂移）。
// 载荷编码版本（ver=1/ver=2）见 test/ver.test.ts，勿混。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_VERSION } from '../src/version.js';

describe('客户端版本单一来源（src/version.ts）', () => {
  it('与 package.json 的 version 一致', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(CLIENT_VERSION).toBe(pkg.version);
  });

  it('语义化版本形态（服务端按 client_version 做最低版本门槛判定）', () => {
    expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
