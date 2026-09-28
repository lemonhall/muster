import type { Bindings } from "./env";
import { JSON_CONTENT_TYPE } from "./http/grpc";
import { Router } from "./http/router";
import { registerChannelRoutes } from "./http/routes/channel";
import { registerSocialRoutes } from "./http/routes/authenticate-social";
import { registerFriendRoutes } from "./http/routes/friend";
import { registerGroupRoutes } from "./http/routes/group";
import { registerIdentityRoutes } from "./http/routes/identity";
import { registerLeaderboardRoutes } from "./http/routes/leaderboard";
import { registerMatchRoutes } from "./http/routes/match";
import { registerNotificationRoutes } from "./http/routes/notification";
import { registerPartyRoutes } from "./http/routes/party";
import { registerRpcRoutes } from "./http/routes/rpc";
import { registerSocketRoutes } from "./http/routes/socket";
import { registerStorageRoutes } from "./http/routes/storage";
import { registerTournamentRoutes } from "./http/routes/tournament";

// Durable Object 的类必须从入口模块导出，`wrangler.jsonc` 里的 migrations 才找得到它们。
export { Channel } from "./durable/channel";
export { Match } from "./durable/match";
export { Matchmaker } from "./durable/matchmaker";
export { Party } from "./durable/party";
export { SessionRegistry } from "./durable/session-registry";
export { SessionShard } from "./durable/session-shard";

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

// `/` 不在上游的 REST 表里（91 个操作没有它），是上游 grpc-gateway 外层给的一个
// "进程活着"的空响应，所以它走 handlePublic，不参与上游对账。
router.handlePublic("GET", "/", () => new Response(null, { status: 200 }));

router.handlePublic(
  "GET",
  "/healthcheck",
  () => new Response("{}", { status: 200, headers: { "content-type": JSON_CONTENT_TYPE } }),
);

registerIdentityRoutes(router);
registerStorageRoutes(router);
// 频道历史在存储之后注册：两者路径不重叠，先后无关，但把"新加的里程碑"排在后面读起来顺。
registerChannelRoutes(router);
registerFriendRoutes(router);
registerGroupRoutes(router);
// 通知排最后：它会用到好友域与群组域发出的通知，但路由本身互不重叠。
registerNotificationRoutes(router);
registerSocialRoutes(router);
// 竞技域（排行榜与锦标赛）注册在社交之后：路径前缀不同，先后无关。
registerTournamentRoutes(router);
registerLeaderboardRoutes(router);
// 对局列表与匹配器统计：前缀 `/v2/match` 与上面的路径不重叠，排在竞技域之后。
registerMatchRoutes(router);
// 派对目录：前缀 `/v2/party`，与上面的路径不重叠，排在匹配之后。
registerPartyRoutes(router);
// 运行时 RPC：路径是 `/v2/rpc/{id}`，鉴权自带第三条规则（http_key），所以它自己解析。
registerRpcRoutes(router);
registerSocketRoutes(router);

export default {
  fetch(request: Request, env: Bindings): Response | Promise<Response> {
    return router.fetch(request, env);
  },
} satisfies ExportedHandler<Bindings>;
