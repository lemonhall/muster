/**
 * 身份/会话/账号的领域逻辑（对外只用这个入口）。
 *
 * 每一条校验消息、每一个错误码都照上游抄录（`api_authenticate.go` / `core_authenticate.go`），
 * 不做"顺手改好一点"：客户端与 SDK 会按这些字符串做分支判断。
 *
 * 全部入口都要求 `tenantId`——多租户不是可选参数，是这一层的形状（ECN-0001）。
 *
 * 文件分工：
 *   - `types.ts`        类型与默认过期时间；
 *   - `validate.ts`     输入校验与账号状态守卫（含 UNIQUE 冲突探测）；
 *   - `session.ts`      签发/刷新/登出/解析 Bearer；
 *   - `authenticate.ts` 设备、自定义、邮箱三种认证；
 *   - `account.ts`      账号资料与用户查询。
 */

import { Code } from "../../../http/grpc";

export * from "./types";
export * from "./validate";
export * from "./session";
export * from "./authenticate";
export * from "./account";

/** 供 wire 层复用：把 gRPC Code 值集中在这里，避免散落魔法数字。 */
export const GrpcCode = Code;
