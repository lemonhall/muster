/**
 * M1 契约测试：设备认证与自定义认证
 *
 * 拆自原 `tests/integration/identity.test.ts`（文件太长，按主题分家）。
 * 共享常量与整份契约源清单见 `tests/helpers/identity-fixtures.ts`。
 * 测试只跑本地 workerd + 本地 D1，不碰任何 Cloudflare 远端资源。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { DEVICE, errorBody } from "../../helpers/identity-fixtures";
import { type SessionBody, TENANT_A_REF, basicAuth, call, createBothTenants, deviceAuth, findUserByIdentity } from "../../helpers/tenants";

beforeAll(async () => {
  await createBothTenants();
});

describe("M1 契约: 设备认证", () => {
  it("test_authenticate_device_creates_account_and_returns_session", async () => {
    const res = await deviceAuth(TENANT_A_REF, DEVICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionBody;
    expect(body.created).toBe(true);
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.refresh_token.split(".")).toHaveLength(3);

    // 用户 id 是规范大写 UUID（上游 uuid.Must(uuid.NewV4()).String()）。
    const user = await findUserByIdentity(TENANT_A_REF.id, "device", DEVICE);
    expect(user?.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u);
  });

  it("test_authenticate_device_twice_reuses_account_and_omits_created", async () => {
    const first = await deviceAuth(TENANT_A_REF, "device-id-000002");
    const second = await deviceAuth(TENANT_A_REF, "device-id-000002");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as SessionBody;
    // protojson 省略零值 → created=false 时整个键都不出现。
    expect("created" in secondBody).toBe(false);
    expect(secondBody.token).not.toBe(((await first.json()) as SessionBody).token);
  });

  it("test_authenticate_device_without_create_returns_404_when_unknown", async () => {
    const res = await deviceAuth(TENANT_A_REF, "device-id-000003", "?create=false");
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({ code: 5, message: "User account not found." });
  });

  it("test_authenticate_device_rejects_short_id", async () => {
    const res = await deviceAuth(TENANT_A_REF, "short");
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: 3,
      message: "Device ID invalid, must be 10-128 bytes.",
    });
  });

  it("test_authenticate_device_rejects_id_with_spaces", async () => {
    const res = await deviceAuth(TENANT_A_REF, "device id 0004");
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: 3,
      message: "Device ID invalid, no spaces or control characters allowed.",
    });
  });

  it("test_authenticate_device_requires_id", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: {},
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Device ID is required." });
  });

  it("test_authenticate_device_with_username_conflict_returns_409", async () => {
    const taken = "taken-name-01";
    const first = await call(`/v2/account/authenticate/device?create=true&username=${taken}`, {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "device-id-000010" },
    });
    expect(first.status).toBe(200);
    const second = await call(`/v2/account/authenticate/device?create=true&username=${taken}`, {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "device-id-000011" },
    });
    expect(second.status).toBe(409);
    expect(await errorBody(second)).toEqual({ code: 6, message: "Username is already in use." });
  });

  it("test_authenticate_with_empty_body_reports_unexpected_eof", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      rawBody: "",
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "unexpected EOF" });
  });

  it("test_authenticate_with_json_null_reports_missing_account", async () => {
    // 上游：body 解成 nil → `in.Account == nil` → 报的是"缺 ID"而不是 JSON 语法错。
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      rawBody: "null",
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Device ID is required." });
  });

  it("test_create_query_defaults_to_true_when_absent", async () => {
    const res = await call("/v2/account/authenticate/device", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "device-id-000012" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).created).toBe(true);
  });
});


describe("M1 契约: 自定义认证", () => {
  it("test_authenticate_custom_requires_six_bytes", async () => {
    const res = await call("/v2/account/authenticate/custom?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "abcde" },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Custom ID invalid, must be 6-128 bytes." });
  });

  it("test_authenticate_custom_creates_account", async () => {
    const res = await call("/v2/account/authenticate/custom?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "custom-id-01" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).created).toBe(true);
  });
});

