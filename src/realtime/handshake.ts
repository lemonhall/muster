/**
 * `/ws` 握手：把"查询参数 + Authorization 头"翻译成一条已鉴权的实时会话。
 *
 * 每一条规则都逐字对齐上游 `server/socket_ws.go` 的 `NewSocketWsAcceptor`：
 *
 * 1. `format` 只认 `""` / `json` / `protobuf`；**缺省是 json**（不是 protobuf！），
 *    其余一律 400 `Invalid format parameter`；
 * 2. 有 `Authorization` 头就必须是 `Bearer ` 前缀，否则 401 `Missing or invalid token`；
 *    没有这个头才退到查询参数 `token`；两条路都拿不到 → 同一条 401；
 * 3. 令牌解析失败 / 会话已吊销 / 账号不存在或封禁 → 同一条 401（不泄露到底哪里不对）；
 * 4. `status` 用 Go `strconv.ParseBool` 的语义（只认 1/t/T/TRUE/true/True 为真）；
 * 5. `lang` 缺省是 `en`。
 *
 * 失败响应的形状是 Go `http.Error`（`text/plain; charset=utf-8` + 末尾换行），
 * 不是 RPC 的错误体——握手发生在 RPC 通道之外。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 *
 * REQ-0001-008
 */

import type { Bindings } from "../env";
import type { ResolvedSession, TenantEnv } from "../domain/identity/service";
import { resolveBearerSession } from "../domain/identity/service";
import { peekTenantId } from "../domain/identity/token";
import { findTenantById } from "../domain/tenancy/store";
import { nowSeconds, tenantEnvOf } from "../http/auth";
import type { SessionFormat } from "./envelope";

/** Go `http.Error` 用的 Content-Type，逐字一致。 */
export const HANDSHAKE_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** 握手阶段被拒：带着要回给客户端的 HTTP 状态码与单行消息。 */
export class HandshakeRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HandshakeRejection";
  }

  toResponse(): Response {
    return new Response(`${this.message}\n`, {
      status: this.status,
      headers: { "content-type": HANDSHAKE_TEXT_CONTENT_TYPE },
    });
  }
}

export function parseSessionFormat(raw: string | null): SessionFormat {
  switch (raw ?? "") {
    case "":
    case "json":
      return "json";
    case "protobuf":
      return "protobuf";
    default:
      throw new HandshakeRejection(400, "Invalid format parameter");
  }
}

/**
 * Go `strconv.ParseBool` 的等价物。上游**忽略**解析错误只看返回值，
 * 所以非法输入等价于 false，不是报错。
 */
export function parseStatusFlag(raw: string | null): boolean {
  return raw === "1" || raw === "t" || raw === "T" || raw === "TRUE" || raw === "true" || raw === "True";
}

export function parseLang(raw: string | null): string {
  return raw === null || raw === "" ? "en" : raw;
}

/** 先看头、再看查询参数；头存在但前缀不对是**直接拒绝**，不退回查询参数。 */
export function extractHandshakeToken(request: Request, url: URL): string {
  const header = request.headers.get("authorization");
  if (header !== null) {
    if (!header.startsWith("Bearer ")) throw new HandshakeRejection(401, "Missing or invalid token");
    return header.slice("Bearer ".length);
  }
  return url.searchParams.get("token") ?? "";
}

export interface SocketHandshake {
  readonly tenantEnv: TenantEnv;
  readonly session: ResolvedSession;
  readonly sessionId: string;
  readonly format: SessionFormat;
  readonly lang: string;
  readonly wantsStatus: boolean;
  readonly clientIp: string;
}

/**
 * 完整握手鉴权。

 * 租户解析顺序与 HTTP 那道完全一致（ECN-0001）：先**不验签**读出 `gid` 选钥匙，
 * 再用该租户的派生密钥验签；验完还要过会话吊销与账号状态两道关。
 */
export async function authenticateSocketHandshake(
  env: Bindings,
  request: Request,
  url: URL,
  now = nowSeconds(),
): Promise<SocketHandshake> {
  const format = parseSessionFormat(url.searchParams.get("format"));
  const token = extractHandshakeToken(request, url);

  if (token === "") throw new HandshakeRejection(401, "Missing or invalid token");
  const tenantId = peekTenantId(token);
  if (tenantId === null) throw new HandshakeRejection(401, "Missing or invalid token");

  const tenant = await findTenantById(env.DB, tenantId);
  if (tenant === null) throw new HandshakeRejection(401, "Missing or invalid token");

  const tenantEnv = tenantEnvOf(env, tenant.id, now);
  let session: ResolvedSession;
  try {
    session = await resolveBearerSession(tenantEnv, token);
  } catch {
    // 领域层的失败消息是 RPC 形状（`Auth token invalid`）；握手这一层统一换成
    // 上游 socket 入口的措辞。客户端在握手阶段只看得到这一句。
    throw new HandshakeRejection(401, "Missing or invalid token");
  }

  return {
    tenantEnv,
    session,
    sessionId: crypto.randomUUID(),
    format,
    lang: parseLang(url.searchParams.get("lang")),
    wantsStatus: parseStatusFlag(url.searchParams.get("status")),
    clientIp: request.headers.get("cf-connecting-ip") ?? "127.0.0.1",
  };
}
