/**
 * 厂商调用的默认传输层，以及一个**仅供同进程替换**的注入点。
 *
 * 为什么要注入（ECN-0014 偏差 5）：内购校验是本项目唯一一处"要打第三方端点"的地方，
 * 而验收要求是"伪造收据被拒、且不带出任何账本副作用"。让测试真的去打 Apple 既不可复现
 * （沙盒收据会过期）也不允许（会外呼、会花钱、会在 CI 里不稳定）。
 *
 * 做法与 M8 的运行时模块宿主一致：默认实现是真 `fetch`，测试在同一个 isolate 里把它
 * 换成假响应，跑完还原。**生产代码里没有任何开关能把它换成别的东西**——`null` 只能是
 * "还原成真 fetch"，不是"禁用出网后假装成功"。
 *
 * 契约源（机器可读）：
 * 契约源: iap/iap.go::ValidateLegacyReceiptAppleWithUrl
 *
 * REQ-0001-022
 */

import type { IapTransport } from "./types";

/**
 * 默认传输层：POST JSON，把状态码与响应体**原样**带回去。
 *
 * Content-Type 逐字照搬上游（`application/json; charset=utf-8`）；不解析响应体，
 * 因为非 200 时那份原文要进错误消息与日志。
 */
export const fetchTransport: IapTransport = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.text() };
};

let current: IapTransport = fetchTransport;

export function iapTransport(): IapTransport {
  return current;
}

/** 传 `null` 表示还原成真 `fetch`（测试的 `afterAll` 走这里）。 */
export function setIapTransport(transport: IapTransport | null): void {
  current = transport ?? fetchTransport;
}
