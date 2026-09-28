import type { HttpMethod } from "./router";

/**
 * 上游 REST 面的一个操作。表本身由 `scripts/gen-endpoint-table.mjs` 生成。
 *
 * `auth` 是对上游 **swagger security + 服务端拦截器** 的合并还原（两处都要看，
 * 只看 swagger 会把 `/healthcheck` 误判成需要令牌）：
 * - `server-key`：只需要 `Authorization: Basic base64(<server_key>:)`（认证类端点）
 * - `user`：需要用户 Bearer 令牌
 * - `user-or-http-key`：RPC 面，用户令牌或 `http_key` 二选一
 * - `none`：不需要鉴权（上游拦截器里硬豁免的 `/healthcheck`）
 */
export interface UpstreamEndpoint {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operation: string;
  readonly auth: "server-key" | "user" | "user-or-http-key" | "none";
}

/** 把 `/v2/user/{userId}/group` 这样的模板拆成段，供路由器匹配。 */
export function splitPathTemplate(template: string): string[] {
  return template.split("/").filter((segment) => segment !== "");
}

/** 模板段是否是参数（`{xxx}`）。 */
export function isParamSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}
