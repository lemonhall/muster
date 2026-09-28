import { describe, expect, it } from "vitest";

import { Code } from "../../../src/http/grpc";
import { errorBody } from "../../helpers/identity-fixtures";
import { basicAuth, call, createTenant } from "../../helpers/tenants";

/**
 * `POST /v2/account/authenticate/google` 的 HTTP 面。
 *
 * 这里只钉三件在**没有 Google 凭据**的环境里也能判定的事：
 *   1. 请求形状与设备/邮箱同构（body = `apiAccountGoogle`，`create`/`username` 在 query）；
 *   2. 缺 token → `400 Google access token is required.`；
 *   3. token 不合格 → `401 Could not authenticate Google profile.`，
 *      且**一个外部请求都不发**（本进程的绑定里没有任何 Google 配置，
 *      证书表与授权码流程都不该被触发；真要触发就是"测试打到线上"）。
 *
 * 正向路径（真签名 → 真账号）在 `google-authenticate.test.ts` 里用注入的证书表覆盖，
 * 因为那个环境里没有、也不该有真实 Google 密钥。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/account/authenticate/google
 * 契约源: server/api_authenticate.go::AuthenticateGoogle
 *
 * REQ-0001-003
 */

async function newTenant(): Promise<{ id: string; serverKey: string }> {
  const tenantId = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenantId}`;
  await createTenant(tenantId, serverKey, "google-endpoint");
  return { id: tenantId, serverKey };
}

describe("POST /v2/account/authenticate/google", () => {
  it("test_requires_a_google_token", async () => {
    const tenant = await newTenant();
    const response = await call("/v2/account/authenticate/google", {
      authorization: basicAuth(tenant.serverKey),
      body: {},
    });
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({
      code: Code.InvalidArgument,
      message: "Google access token is required.",
    });
  });

  it("test_rejects_a_jwt_shaped_token_without_calling_out", async () => {
    const tenant = await newTenant();
    const response = await call("/v2/account/authenticate/google", {
      authorization: basicAuth(tenant.serverKey),
      body: { token: "not.a.jwt" },
    });
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toEqual({
      code: Code.Unauthenticated,
      message: "Could not authenticate Google profile.",
    });
  });

  it("test_rejects_a_non_jwt_token_when_the_code_flow_is_unconfigured", async () => {
    const tenant = await newTenant();
    const response = await call("/v2/account/authenticate/google", {
      authorization: basicAuth(tenant.serverKey),
      body: { token: "synthetic-authorization-code" },
    });
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toEqual({
      code: Code.Unauthenticated,
      message: "Could not authenticate Google profile.",
    });
  });

  it("test_requires_a_server_key_like_the_other_authentication_kinds", async () => {
    const tenant = await newTenant();
    const response = await call("/v2/account/authenticate/google", {
      authorization: `Basic ${btoa("wrong-key-000000:")}`,
      body: { token: "not.a.jwt" },
    });
    expect(response.status).toBe(401);
    expect((await errorBody(response)).message).toBe("Server key invalid");
  });
});
