import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// 客户端版本单一来源（src/version.ts 的 __ATLAS_SDK_VERSION__）：测试期同样从
// package.json 注入，与 tsup 构建注入保持同一表达式（见 tsup.config.ts）。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// 测试只收集 test/ 目录（src/ 保持纯实现，不混入测试文件）。
export default defineConfig({
  define: { __ATLAS_SDK_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
