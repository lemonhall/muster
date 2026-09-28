/**
 * `POST|GET /v2/rpc/{id}`：把租户模块注册的 RPC 暴露给客户端。
 *
 * 这个端点**不走路由器的鉴权分类**，因为它有第三条规则：`?http_key=<server_key>`
 * 可以不带头就通过（服务端之间互调）。所以它注册成 public，自己解析三种来源——
 * 顺序与错误体逐字对齐上游 `api_rpc.go::RpcFuncHttp`：
 *
 *   1. `?http_key=` → server key（不对 → 401 `HTTP key invalid`）；
 *   2. `Authorization: Basic ...` → 同上（上游把 Basic 也当 server key 看）；
 *   3. `Authorization: Bearer ...` → 用户令牌（不对 → 401 `Auth token invalid`）；
 *   4. 都没有 → 401 `Auth token or HTTP key required`。
 *
 * 另外两条容易漏掉的细节：
 * - 路径里的 id **转小写**再查（`strings.ToLower(maybeID)`），所以注册名大小写不敏感；
 * - 不带 `?unwrap` 时，请求体必须是一个 **JSON 字符串**，回包是 `{"payload":<字符串>}`。
 *   这是上游"模仿 grpc-gateway 行为"的那一段：payload 在协议上本来就是字符串，
 *   客户端 SDK 再自己解一次。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_rpc.go::ApiServer.RpcFuncHttp
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/rpc/{id}
 *
 * REQ-0001-020
 */

import type { Bindings } from "../../env";
import { parseBasicAuth, parseBearerAuth, resolveBearerContext } from "../auth";
import { ApiError } from "../errors";
import { JSON_CONTENT_TYPE, statusResponse } from "../grpc";
import type { PublicContext, Router } from "../router";
import { findTenantByServerKey } from "../../domain/tenancy/store";
import { callTenantRpc } from "../../runtime/service";

const HTTP_KEY_INVALID = "HTTP key invalid";
const AUTH_TOKEN_INVALID = "Auth token invalid";
const NO_AUTH = "Auth token or HTTP key required";
const RPC_ID_MUST_BE_SET = "RPC ID must be set";
const RPC_NOT_FOUND = "RPC function not found";
const BAD_JSON = "json: cannot unmarshal object into Go value of type string";
const INTERNAL_ERROR = "Internal Server Error";

/** 上游 `api_rpc.go` 里那几份手写错误体带一个额外的 `error` 字段，照抄。 */
function rpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ error: message, message, code }), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

interface Principal {
  readonly tenantId: string;
  readonly userId: string;
  readonly username: string;
}

async function resolvePrincipal(env: Bindings, context: PublicContext): Promise<Principal | Response> {
  const httpKey = context.url.searchParams.get("http_key") ?? "";
  if (httpKey !== "") {
    const tenant = await findTenantByServerKey(env.DB, httpKey);
    if (tenant === null) return rpcError(401, 16, HTTP_KEY_INVALID);
    return { tenantId: tenant.id, userId: "", username: "" };
  }

  const header = context.request.headers.get("authorization");
  if (header === null || header === "") return rpcError(401, 16, NO_AUTH);

  const basic = parseBasicAuth(header);
  if (basic !== null) {
    const tenant = await findTenantByServerKey(env.DB, basic);
    if (tenant === null) return rpcError(401, 16, HTTP_KEY_INVALID);
    return { tenantId: tenant.id, userId: "", username: "" };
  }

  if (parseBearerAuth(header) === null) return rpcError(401, 16, AUTH_TOKEN_INVALID);
  try {
    const resolved = await resolveBearerContext(env, context.request);
    return {
      tenantId: resolved.tenantEnv.tenantId,
      userId: resolved.session.user.id,
      username: resolved.session.user.username,
    };
  } catch {
    return rpcError(401, 16, AUTH_TOKEN_INVALID);
  }
}

/** 上行 payload：POST 且不带 `unwrap` 时必须是 JSON 字符串。 */
async function readPayload(request: Request, unwrap: boolean): Promise<string | Response> {
  if (request.method.toUpperCase() !== "POST") return "";
  const body = await request.text();
  if (body === "" || unwrap) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return rpcError(400, 3, BAD_JSON);
  }
  return typeof parsed === "string" ? parsed : rpcError(400, 3, BAD_JSON);
}

async function handle(env: Bindings, context: PublicContext): Promise<Response> {
  const principal = await resolvePrincipal(env, context);
  if (principal instanceof Response) return principal;

  const rawId = context.params["id"] ?? "";
  if (rawId === "") return rpcError(400, 3, RPC_ID_MUST_BE_SET);
  const id = rawId.toLowerCase();

  const unwrap = context.url.searchParams.has("unwrap");
  const payload = await readPayload(context.request, unwrap);
  if (payload instanceof Response) return payload;

  const invocation = await callTenantRpc(
    env,
    principal.tenantId,
    { userId: principal.userId, username: principal.username, sessionId: "" },
    id,
    payload,
  );
  if (invocation.kind === "missing") return rpcError(404, 5, RPC_NOT_FOUND);
  if (invocation.kind === "error") {
    // RPC 段的两类失败：模块自己抛（上游给 Unknown）。用同一个错误体形状报回去。
    return rpcError(400, 2, invocation.message);
  }

  if (unwrap) {
    const contentType = context.request.headers.get("content-type") ?? "text/plain";
    return new Response(invocation.payload, { status: 200, headers: { "content-type": contentType } });
  }
  return new Response(JSON.stringify({ payload: invocation.payload }), {
    status: 200,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

export function registerRpcRoutes(router: Router): void {
  const handler = async (context: PublicContext): Promise<Response> => {
    try {
      return await handle(context.env, context);
    } catch (error) {
      if (error instanceof ApiError) return error.toResponse();
      console.error("RPC 执行失败", error);
      return statusResponse(13, INTERNAL_ERROR);
    }
  };
  router.handlePublic("POST", "/v2/rpc/{id}", handler);
  router.handlePublic("GET", "/v2/rpc/{id}", handler);
}
