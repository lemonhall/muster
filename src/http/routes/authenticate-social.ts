/**
 * 社交登录的 REST 端点。
 *
 * M5 只交付 **Google** 这一条：
 *
 *   POST /v2/account/authenticate/google   （server-key 类，BasicAuth）
 *
 * 请求形状与设备/邮箱那几条**同构**：body 就是 `apiAccountGoogle`（`token` + `vars`），
 * `create` 与 `username` 在 query 上（swagger 里 `account` 是唯一 body 参数，其余 `in: query`）。
 *
 * Apple / Facebook / Steam / GameCenter 需要真实凭据与真实密钥交换，本地与 CI 里都没有，
 * 所以它们**不注册路由**：上游对这些 provider 未配置时回的是
 * `Unauthenticated "Provider is not configured."` 一类错误，而本项目还没有实现它们的
 * 密钥交换，未实现的路径统一回 `Not implemented.`（诚实地说"有、没做"，不假装配好了）。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/account/authenticate/google
 * 契约源: server/api_authenticate.go::AuthenticateGoogle
 */

import { asObject, json, optionalString, optionalStringMap, parseBody, queryBool } from "../body";
import type { Router } from "../router";
import { authenticateGoogle } from "../../domain/social/google/authenticate";
import { googleDepsOf } from "../../domain/social/google/config";
import { sessionBody } from "../../wire/identity";

export function registerSocialRoutes(router: Router): void {
  router.handleServerKey("POST", "/v2/account/authenticate/google", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    const session = await authenticateGoogle(
      context.tenantEnv,
      {
        token: optionalString(body, "token") ?? "",
        username: optionalString(body, "username"),
        create: queryBool(context.url, "create", true),
        vars: optionalStringMap(body, "vars"),
      },
      googleDepsOf(context.env),
    );
    return json(sessionBody(session));
  });
}
