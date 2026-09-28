import type { Bindings } from "../env";
import type { TenantEnv, ResolvedSession } from "../domain/identity/service";
import { UPSTREAM_REST_ENDPOINTS } from "./endpoints.generated";
import { isParamSegment } from "./endpoints";
import { ApiError, internal } from "./errors";
import { Code, statusResponse } from "./grpc";
import { resolveBearerContext, resolveServerKeyTenant } from "./auth";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** 已认证请求的上下文：`tenantEnv` 一定存在（由 router 保证，不是靠处理器自觉）。 */
export interface AuthedContext {
  readonly env: Bindings;
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly tenantEnv: TenantEnv;
}

export interface UserContext extends AuthedContext {
  readonly session: ResolvedSession;
}

export interface PublicContext {
  readonly env: Bindings;
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

type Handler<C> = (context: C) => Response | Promise<Response>;

interface Route {
  readonly method: HttpMethod;
  readonly template: string;
  readonly segments: readonly string[];
  readonly kind: "public" | "server-key" | "user";
  readonly handler: Handler<never>;
}

interface UpstreamPath {
  readonly template: string;
  readonly segments: readonly string[];
  readonly methods: Set<string>;
}

function segmentsOf(template: string): string[] {
  return template.split("/").filter((segment) => segment !== "");
}

/** 模板匹配；命中时返回路径参数，否则返回 null。 */
function matchTemplate(
  templateSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> | null {
  if (templateSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const template = templateSegments[index] as string;
    const actual = pathSegments[index] as string;
    if (isParamSegment(template)) {
      params[template.slice(1, -1)] = decodeURIComponent(actual);
      continue;
    }
    if (template !== actual) return null;
  }
  return params;
}

/**
 * 方法感知的路径路由器 + **上游对账面**。
 *
 * 分发规则（四层，顺序不可颠倒）：
 *   1. 命中已实现的 (方法, 路径) → 交给处理器；
 *   2. 路径已实现但方法不符 → 501 `Method Not Allowed`（上游同款反直觉语义，
 *      见 M0 的说明：handleRoutingError 把 405 映射成 codes.Unimplemented）；
 *   3. 路径在上游存在但本项目还没实现 → 501 `Not implemented.`
 *      —— 这条很重要：对客户端诚实地说"这条路有、我们还没做"，而不是 404 假装不存在；
 *   4. 上游也没有这条路 → 404 `Not Found`。
 *
 * 鉴权在分发这一层统一执行（对应上游的 securityInterceptorFunc）：处理器拿到的
 * 上下文里 `tenantEnv` 已经解析好，处理器不再自己解析 Authorization 头。
 *
 * 鉴权来源按路由类别区分（对应上游拦截器的 switch）：
 * - `server-key`（认证/刷新类）：租户来自 `Basic <server_key>`
 * - `user`（其余全部）：租户来自 Bearer 令牌的 `gid`，**不需要** server key
 */
export class Router {
  readonly #routes: Route[] = [];
  readonly #upstream = new Map<string, UpstreamPath>();

  constructor() {
    for (const endpoint of UPSTREAM_REST_ENDPOINTS) {
      const key = endpoint.path;
      const existing = this.#upstream.get(key);
      if (existing === undefined) {
        this.#upstream.set(key, {
          template: endpoint.path,
          segments: segmentsOf(endpoint.path),
          methods: new Set([endpoint.method]),
        });
      } else {
        existing.methods.add(endpoint.method);
      }
    }
  }

  handlePublic(method: HttpMethod, template: string, handler: Handler<PublicContext>): this {
    return this.#register(method, template, "public", handler as Handler<never>);
  }

  handleServerKey(method: HttpMethod, template: string, handler: Handler<AuthedContext>): this {
    return this.#register(method, template, "server-key", handler as Handler<never>);
  }

  handleUser(method: HttpMethod, template: string, handler: Handler<UserContext>): this {
    return this.#register(method, template, "user", handler as Handler<never>);
  }

  #register(
    method: HttpMethod,
    template: string,
    kind: Route["kind"],
    handler: Handler<never>,
  ): this {
    if (this.#routes.some((route) => route.method === method && route.template === template)) {
      throw new Error(`duplicate route: ${method} ${template}`);
    }
    this.#routes.push({ method, template, segments: segmentsOf(template), kind, handler });
    return this;
  }

  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathSegments = segmentsOf(url.pathname);

    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const params = matchTemplate(route.segments, pathSegments);
      if (params === null) continue;
      return this.#invoke(route, request, url, env, params);
    }

    const implementedPath = this.#routes.some((route) => matchTemplate(route.segments, pathSegments) !== null);
    if (implementedPath) {
      // http.StatusText(405) === "Method Not Allowed"，经 codes.Unimplemented 反推成 501
      return statusResponse(Code.Unimplemented, "Method Not Allowed");
    }

    for (const upstream of this.#upstream.values()) {
      if (matchTemplate(upstream.segments, pathSegments) === null) continue;
      if (upstream.methods.has(method)) {
        return statusResponse(Code.Unimplemented, "Not implemented.");
      }
      return statusResponse(Code.Unimplemented, "Method Not Allowed");
    }

    return statusResponse(Code.NotFound, "Not Found");
  }

  async #invoke(
    route: Route,
    request: Request,
    url: URL,
    env: Bindings,
    params: Record<string, string>,
  ): Promise<Response> {
    try {
      const handler = route.handler as Handler<PublicContext | AuthedContext | UserContext>;
      if (route.kind === "public") {
        return await handler({ env, request, url, params });
      }
      if (route.kind === "server-key") {
        const tenantEnv = await resolveServerKeyTenant(env, request);
        return await handler({ env, request, url, params, tenantEnv });
      }
      const { tenantEnv, session } = await resolveBearerContext(env, request);
      return await handler({ env, request, url, params, tenantEnv, session });
    } catch (error) {
      if (error instanceof ApiError) {
        return error.toResponse();
      }
      // 未预期的异常：对外统一是 500 Internal，细节只进日志。
      console.error("unhandled error while serving request", error);
      return internal("Internal error.").toResponse();
    }
  }
}
