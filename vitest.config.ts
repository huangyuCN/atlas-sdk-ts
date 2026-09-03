import { defineConfig } from 'vitest/config';

// 测试只收集 test/ 目录（src/ 保持纯实现，不混入测试文件）。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
