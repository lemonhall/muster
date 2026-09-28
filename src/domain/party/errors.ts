/**
 * 派对的失败类型与逐字文案。
 *
 * 上游把两类东西拼进同一条错误帧：**管线的前缀**（`Error joining party: `）+
 * **服务层的错误串**（`party not found` / `party full` / ...）。两段都要逐字对齐，
 * 所以这段文案分成两张表：
 *
 * - `PARTY_FAILURE_TEXT`：服务层错误串，取自上游 `runtime.ErrParty*` 与
 *   `server/party_registry.go` 里那两个 `errors.New`（`party not found` 等）；
 * - 管线前缀在 `src/realtime/pipeline-party.ts` 里，与操作一一对应。
 *
 * 为什么要这么较真：客户端 SDK 会把错误文案原样交给开发者，文案错一个字，
 * "同一个后端、同一套 SDK"就不成立了。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::ErrPartyNotFound
 * 契约源: server/party_handler.go::PartyHandler.JoinRequest
 *
 * REQ-0001-019
 */

export type PartyFailureKind =
  | "not-found"
  | "closed"
  | "full"
  | "join-request-duplicate"
  | "join-request-already-member"
  | "join-requests-full"
  | "not-leader"
  | "not-member"
  | "not-request"
  | "accept-request"
  | "remove"
  | "remove-self"
  | "label-too-long"
  | "label-invalid"
  | "hidden-label";

/** 服务层错误串。`label-invalid` 带参数，单独一条函数。 */
const PARTY_FAILURE_TEXT: Readonly<Record<Exclude<PartyFailureKind, "label-invalid">, string>> = {
  "not-found": "party not found",
  closed: "party closed",
  full: "party full",
  "join-request-duplicate": "party join request duplicate",
  "join-request-already-member": "party join request already member",
  "join-requests-full": "party join requests full",
  "not-leader": "party leader only",
  "not-member": "party member not found",
  "not-request": "party join request not found",
  "accept-request": "party could not accept request",
  remove: "party could not remove",
  "remove-self": "party cannot remove self",
  "label-too-long": "party label too long",
  "hidden-label": "party is hidden and label is not empty, invalid operation",
};

export class PartyError extends Error {
  readonly kind: PartyFailureKind;

  constructor(kind: PartyFailureKind, message?: string) {
    super(message ?? failureText(kind));
    this.name = "PartyError";
    this.kind = kind;
  }
}

/** 服务层错误串（上游 `err.Error()` 的那一半）。 */
export function failureText(kind: PartyFailureKind): string {
  if (kind === "label-invalid") return "failed to unmarshal party label";
  return PARTY_FAILURE_TEXT[kind];
}

/** 标签不是合法 JSON 对象时，上游拼的是 `failed to unmarshal party label: <err>`。 */
export function labelInvalid(detail: string): PartyError {
  return new PartyError("label-invalid", `failed to unmarshal party label: ${detail}`);
}
