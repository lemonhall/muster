import { beforeEach, describe, expect, it } from "vitest";
import { checkGoogleToken } from "../../../src/domain/social/google/token";
import { signingFixture, type SigningFixture } from "../../helpers/google-jwt";

/**
 * 搬运上游 `social/google_token_audience_test.go::TestCheckGoogleTokenValidatesAudience`
 * 的 8 个子用例与 2 个独立子用例，外加签发者 / 有效期 / 算法三条边界。
 *
 * 每个 token 都由本机生成的 RSA 私钥签名、由被测代码用公钥验过——所以
 * "aud 校验通过"这件事发生在一条**真的验过签**的分支上，不是在一个没验签的桩上。
 */

const TARGET = "target-client.apps.googleusercontent.com";
const MOBILE = "mobile-client.apps.googleusercontent.com";
const OTHER = "other-client.apps.googleusercontent.com";
const NOW_SEC = 1_800_000_000;

const AUDIENCE_CASES: readonly {
  readonly name: string;
  readonly audience?: unknown;
  readonly authorizedParty?: unknown;
  readonly wantErr: boolean;
}[] = [
  { name: "configured audience without authorized party", audience: TARGET, wantErr: false },
  { name: "configured audience and presenter", audience: TARGET, authorizedParty: TARGET, wantErr: false },
  {
    name: "configured audience and separately allowed presenter",
    audience: TARGET,
    authorizedParty: MOBILE,
    wantErr: false,
  },
  { name: "different OAuth client", audience: OTHER, authorizedParty: OTHER, wantErr: true },
  { name: "untrusted authorized presenter", audience: TARGET, authorizedParty: OTHER, wantErr: true },
  { name: "array audience rejected", audience: [TARGET], authorizedParty: TARGET, wantErr: true },
  { name: "missing audience rejected", authorizedParty: TARGET, wantErr: true },
  { name: "malformed authorized presenter rejected", audience: TARGET, authorizedParty: 1, wantErr: true },
];

describe("M5 契约: Google ID token 的 aud / azp 规则", () => {
  let fixture: SigningFixture;
  beforeEach(async () => {
    fixture = await signingFixture();
  });

  async function tokenFor(claims: Record<string, unknown>): Promise<string> {
    return fixture.sign({
      iss: "https://accounts.google.com",
      sub: "synthetic-google-subject",
      iat: NOW_SEC,
      exp: NOW_SEC + 600,
      ...claims,
    });
  }

  for (const testCase of AUDIENCE_CASES) {
    it(`test_check_google_token_validates_audience::${testCase.name}`, async () => {
      const claims: Record<string, unknown> = {};
      if (testCase.audience !== undefined) claims["aud"] = testCase.audience;
      if (testCase.authorizedParty !== undefined) claims["azp"] = testCase.authorizedParty;
      const token = await tokenFor(claims);

      const result = checkGoogleToken({
        idToken: token,
        clientIds: [TARGET, MOBILE],
        certs: fixture.certs,
        nowSec: NOW_SEC,
      });
      if (testCase.wantErr) await expect(result).rejects.toThrow();
      else await expect(result).resolves.toMatchObject({ googleId: "synthetic-google-subject" });
    });
  }

  it("test_check_google_token_accepts_the_client_id_from_the_oauth_configuration", async () => {
    const token = await tokenFor({ aud: TARGET });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).resolves.toMatchObject({ googleId: "synthetic-google-subject" });
  });

  it("test_check_google_token_accepts_an_unconfigured_client_id_for_backward_compatibility", async () => {
    // 上游 NewClient 在没有任何 client id 时打一条 Warn 后放行；这里是同一条分支。
    const token = await tokenFor({ aud: TARGET });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [], certs: fixture.certs, nowSec: NOW_SEC }),
    ).resolves.toMatchObject({ googleId: "synthetic-google-subject" });
  });

  it("test_check_google_token_rejects_an_expired_token", async () => {
    const token = await tokenFor({ aud: TARGET, exp: NOW_SEC - 1 });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).rejects.toThrow();
  });

  it("test_check_google_token_rejects_a_token_without_exp", async () => {
    const token = await tokenFor({ aud: TARGET, exp: undefined });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).rejects.toThrow();
  });

  it("test_check_google_token_rejects_a_token_from_another_issuer", async () => {
    const token = await tokenFor({ aud: TARGET, iss: "https://accounts.example.com" });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).rejects.toThrow();
  });

  it("test_check_google_token_accepts_the_issuer_without_a_scheme", async () => {
    const token = await tokenFor({ aud: TARGET, iss: "accounts.google.com" });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).resolves.toMatchObject({ iss: "accounts.google.com" });
  });

  it("test_check_google_token_rejects_a_non_rs256_algorithm", async () => {
    const token = await fixture.sign({ iss: "https://accounts.google.com", aud: TARGET, sub: "s" }, { alg: "none" });
    await expect(
      checkGoogleToken({ idToken: token, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).rejects.toThrow();
  });

  it("test_check_google_token_rejects_a_tampered_payload", async () => {
    // 把另一个 token 的 payload 拼到本 token 的签名上：签名对不上，必须拒。
    const original = await tokenFor({ aud: TARGET });
    const attacker = await tokenFor({ aud: TARGET, sub: "somebody-else" });
    const [header, , signature] = original.split(".") as [string, string, string];
    const forged = `${header}.${attacker.split(".")[1] as string}.${signature}`;
    await expect(
      checkGoogleToken({ idToken: forged, clientIds: [TARGET], certs: fixture.certs, nowSec: NOW_SEC }),
    ).rejects.toThrow();
  });
});
