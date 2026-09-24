// 客户端版本单一来源（M1 协议演进：网关按 Login/Resume 请求的 client_version 做
// 最低版本门槛判定，见模板 api/gateway/v1/session.proto 的 LoginRequest.client_version）。
//
// 版本值由构建期注入（tsup.config.ts / vitest.config.ts 的 define 读 package.json 的
// version）——本文件不写字面量，避免「package.json 与源码两处手写」漂移；
// 注入缺失即构建/测试期报错（不留静默兜底）。
declare const __ATLAS_SDK_VERSION__: string;

/** CLIENT_VERSION 是当前 SDK 版本（semver），唯一来源为 package.json 的 version：
 * 登录（Login）与断线恢复（Resume）请求都会带上它（字段名由生成 DTO 钉住）。 */
export const CLIENT_VERSION = __ATLAS_SDK_VERSION__;
