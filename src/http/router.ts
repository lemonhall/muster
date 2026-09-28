import { Code, statusResponse } from "./grpc";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type RouteHandler = (request: Request) => Response | Promise<Response>;

/**
 * 方法感知的精确路径路由器。
 *
 * M0 只需要精确匹配；带路径参数的写法（/v2/rpc/{id}）在 M1 引入 proto 生成的路由表时再加。
 * 这个类只做"注册 + 分发"一件事，业务逻辑一律不进这里。
 *
 * 两个反直觉的状态码是上游的既有行为，照搬，不要"顺手修正"：
 * 上游 handleRoutingError 把 http.StatusMethodNotAllowed 映射成 codes.Unimplemented，
 * 而 DefaultHTTPErrorHandler 随后用 HTTPStatusFromCode 从 code 反推 HTTP 状态，
 * 于是"路径存在但方法不对"最终是 HTTP 501 + {"code":12,"message":"Method Not Allowed"}，
 * 不是 405。未知路径则老老实实是 404 + {"code":5,"message":"Not Found"}。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::handleRoutingError
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::HTTPStatusFromCode
 */
export class Router {
  readonly #byPath = new Map<string, Map<string, RouteHandler>>();

  handle(method: HttpMethod, path: string, handler: RouteHandler): this {
    const byMethod = this.#byPath.get(path) ?? new Map<string, RouteHandler>();
    if (byMethod.has(method)) {
      // 路由重复注册是配置错误：在模块求值阶段就炸掉，而不是留到运行期静默覆盖。
      throw new Error(`duplicate route: ${method} ${path}`);
    }
    byMethod.set(method, handler);
    this.#byPath.set(path, byMethod);
    return this;
  }

  fetch(request: Request): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    const byMethod = this.#byPath.get(pathname);
    if (byMethod === undefined) {
      // http.StatusText(404) === "Not Found"
      return statusResponse(Code.NotFound, "Not Found");
    }
    const handler = byMethod.get(request.method.toUpperCase());
    if (handler === undefined) {
      // http.StatusText(405) === "Method Not Allowed"，经 codes.Unimplemented 反推成 501
      return statusResponse(Code.Unimplemented, "Method Not Allowed");
    }
    return handler(request);
  }
}
