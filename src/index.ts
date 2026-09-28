import { JSON_CONTENT_TYPE } from "./http/grpc";
import { Router } from "./http/router";

/**
 * Worker 入口：只负责把请求交给路由表，不放任何业务逻辑。
 *
 * M0 的三条对外行为全部来自上游实现（不是猜测）：
 * - GET /：上游 grpc-gateway 外层路由对 "/" 只注册 GET，处理函数直接写 200，
 *   既不写响应体也不设 Content-Type —— 所以这里同样是空 body。
 * - GET /healthcheck：RPC 返回 google.protobuf.Empty，protojson 序列化后恰好是 {}。
 * - 其余路径与方法：交给 Router 生成与上游同形状的错误体。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::grpcGatewayRouter
 * 契约源: apigrpc/apigrpc.swagger.json::/healthcheck
 */
const router = new Router();

router.handle("GET", "/", () => new Response(null, { status: 200 }));

router.handle(
  "GET",
  "/healthcheck",
  () => new Response("{}", { status: 200, headers: { "content-type": JSON_CONTENT_TYPE } }),
);

export default {
  fetch(request: Request): Response | Promise<Response> {
    return router.fetch(request);
  },
} satisfies ExportedHandler<Env>;
