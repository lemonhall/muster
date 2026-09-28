/**
 * M1 身份套件的共享工装：常量、错误体解析，以及整份套件的契约源清单。
 *
 * 每条断言的期望值都来自上游源码（不是“看起来应该”），失败消息也逐字对齐——
 * 官方 SDK 会按这些字符串做分支，改一个字就是把 SDK 挡在门外。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::securityInterceptorFunc
 * 契约源: server/api.go::parseBasicAuth
 * 契约源: server/api.go::wwwAuthenticateFixWriter
 * 契约源: server/api_authenticate.go::AuthenticateDevice
 * 契约源: server/api_authenticate.go::AuthenticateEmail
 * 契约源: server/api_authenticate.go::AuthenticateCustom
 * 契约源: server/api_session.go::SessionRefresh
 * 契约源: server/api_session.go::SessionLogout
 * 契约源: server/api_account.go::GetAccount
 * 契约源: server/api_account.go::UpdateAccount
 * 契约源: server/api_user.go::GetUsers
 * 契约源: server/core_authenticate.go::AuthenticateDevice
 * 契约源: server/core_authenticate.go::AuthenticateEmail
 * 契约源: server/core_session.go::SessionRefresh
 * 契约源: server/core_session.go::SessionLogout
 * 契约源: server/core_account.go::UpdateAccounts
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/account/authenticate/device
 *
 * REQ-0001-003, REQ-0001-004, REQ-0001-005
 */

export const DEVICE = "device-id-000001";
export const EMAIL = "player1@example.com";
export const PASSWORD = "supersecret";

export async function errorBody(response: Response): Promise<{ code: number; message: string }> {
  return (await response.json()) as { code: number; message: string };
}
