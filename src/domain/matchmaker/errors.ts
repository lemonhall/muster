/**
 * 匹配池的失败原因。
 *
 * 上游的对应物是 `runtime.ErrMatchmaker*` 这一组错误值；实时管线把它们翻译成
 * 客户端看得见的错误帧（`pipeline_matchmaker.go` 里那句 `Error adding to matchmaker`
 * 就是"宿主错误"那一支的文案）。本项目把"宿主错误"与"票不存在"分开表达，
 * 因为管线对这两条的文案与错误码不同（后者是 `Bad input` + `Matchmaker ticket not found`）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerRemove
 *
 * REQ-0001-017
 */

export type MatchmakerFailure =
  /** 查询串不合法（上游 `ErrMatchmakerQueryInvalid`）。 */
  | "query-invalid"
  /** 同一张票里出现重复会话（上游 `ErrMatchmakerDuplicateSession`）。 */
  | "duplicate-session"
  /** 会话或派对持有的票已达上限（上游 `ErrMatchmakerTooManyTickets`）。 */
  | "too-many-tickets"
  /** 票不存在，或者调用者不是这张票的持有者（上游 `ErrMatchmakerTicketNotFound`）。 */
  | "ticket-not-found"
  /** 池子已停用（上游 `ErrMatchmakerNotAvailable`）。 */
  | "not-available";

export class MatchmakerError extends Error {
  constructor(readonly failure: MatchmakerFailure) {
    super(failure);
    this.name = "MatchmakerError";
  }
}
