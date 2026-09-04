import { defineConfig } from 'tsup';

// 产物三形态（规范 §3.2）：ESM + CJS + d.ts。
// target ES2020：引擎宿主兼容加固（2026-09-01 立项决策）——Cocos Creator 等嵌入式
// JS 引擎（原生 JSB 环境）对 ES2022 语言特性（类字段等）支持无保证，ES2020 有更宽的
// 引擎覆盖面；协议层/内核不依赖 ES2022 独有语法（Error.cause 也按手动赋值约定处理）。
// 协议层与内核不依赖 node 内置模块（纯 Uint8Array/DataView 等语言能力），
// 同一份产物同时服务浏览器与 Node 两个目标。
// 子入口：node（Node TCP/UDP 通道）、protobuf（@bufbuild 依赖的 ProtobufSerializer，
// ver=2——依赖归子入口，主入口零 protobuf 依赖）。
export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/protobuf.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2020',
  clean: true,
  sourcemap: true,
});
