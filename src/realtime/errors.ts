/**
 * 实时协议里的错误帧：`Envelope{ cid, error }`。
 *
 * 错误码取自上游 `realtime.proto` 的 `nakama.realtime.Error.Code` 枚举
 * （生成物里就是 `Error_Code`），消息文本逐字照抄上游 `pipeline.go` /
 * `pipeline_status.go`——客户端 SDK 靠 code 分支、靠 message 给人看。
 *
 * 这里同时记录了一条容易踩的语义：**上游在多数错误后直接关掉会话**。
 * `pipeline.go` 的 `ProcessRequest` 返回 false 时，`sessionWS.consume` 会跳出
 * 读循环并 `Close`，所以"发错误帧"和"保持连接"不是一回事：
 * - `MISSING_PAYLOAD` / `UNRECOGNIZED_PAYLOAD`：发错误帧后关闭；
 * - `BAD_INPUT`（非法 user id、status 超长）：同样关闭。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline.go::Pipeline.ProcessRequest
 */

import { create } from "@bufbuild/protobuf";

import { EnvelopeSchema, Error_Code, ErrorSchema, type Envelope } from "../proto/realtime_pb";

export { Error_Code };

/** 构造一个错误帧。`cid` 原样回带——客户端靠它把错误和请求对上号。 */
export function errorEnvelope(cid: string, code: Error_Code, message: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "error", value: create(ErrorSchema, { code, message }) },
  });
}

/** 空信封（只有 cid）：上游在"收到了、没什么可回"的场景写的就是它。 */
export function ackEnvelope(cid: string): Envelope {
  return create(EnvelopeSchema, { cid });
}

/** 上游 `ProcessRequest`：envelope 里一个消息都没有。 */
export function missingPayloadError(cid: string): Envelope {
  return errorEnvelope(cid, Error_Code.MISSING_PAYLOAD, "Missing message.");
}

/** 上游 `ProcessRequest` 的 default 分支：协议里认得，但这条路不提供。 */
export function unrecognizedPayloadError(cid: string): Envelope {
  return errorEnvelope(cid, Error_Code.UNRECOGNIZED_PAYLOAD, "Unrecognized message.");
}

export function badInputError(cid: string, message: string): Envelope {
  return errorEnvelope(cid, Error_Code.BAD_INPUT, message);
}

/**
 * 运行时 before hook 抛异常：上游回一帧 `RUNTIME_FUNCTION_EXCEPTION` 但**不关连接**
 * （`pipeline.go`：`return true`）。模块写错了不该把玩家踢下线。
 */
export function runtimeFunctionError(cid: string, message: string): Envelope {
  return errorEnvelope(cid, Error_Code.RUNTIME_FUNCTION_EXCEPTION, message);
}

/**
 * 运行时 before hook 返回 nil：上游认为"这个资源被禁用了"，对外表达成
 * `UNRECOGNIZED_PAYLOAD` + "Requested resource was not found."，并关闭连接。
 */
export function disabledResourceError(cid: string): Envelope {
  return errorEnvelope(cid, Error_Code.UNRECOGNIZED_PAYLOAD, "Requested resource was not found.");
}
