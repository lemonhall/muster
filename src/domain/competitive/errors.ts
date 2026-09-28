/**
 * 竞技域的业务失败信号。
 *
 * 上游的领域层返回一批 `errTournament*` / `ErrLeaderboard*` 哨兵错误，由
 * `api_leaderboard.go` / `api_tournament.go` 各自翻成 gRPC 状态与文案——**同一个
 * 领域失败在不同端点上文案不同**（比如"越权写分"在排行榜上是
 * `...authoritative score submissions.`，在锦标赛上是同一个句式但锦标赛自己那份）。
 * 所以这里也只给"失败的种类"，文案留给 HTTP 层，避免把两套文案压成一句。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_leaderboard.go::ListLeaderboardRecords
 * 契约源: server/api_tournament.go::WriteTournamentRecord
 */

export type CompetitiveFailure =
  /** 排行榜/锦标赛不存在。 */
  | "not-found"
  /** 排行榜存在但不是锦标赛（只有锦标赛端点会用它）。 */
  | "not-tournament"
  /** 锦标赛已结束（`end_time` 已过）。 */
  | "ended"
  /** 不在可写分的窗口内（未开赛或已过 `end_active`）。 */
  | "outside-duration"
  /** 覆盖了合法的 operator 取值之外的值。 */
  | "invalid-operator"
  /** 调用方不是权威调用者，而这张榜只接受权威提交。 */
  | "authoritative"
  /** 锦标赛名额已满。 */
  | "max-size"
  /** 达到允许的最大提交次数。 */
  | "max-attempts"
  /** 锦标赛要求先加入再写分。 */
  | "join-required";

export class CompetitiveError extends Error {
  readonly failure: CompetitiveFailure;

  constructor(failure: CompetitiveFailure) {
    super(failure);
    this.name = "CompetitiveError";
    this.failure = failure;
  }
}

export function competitiveError(failure: CompetitiveFailure): CompetitiveError {
  return new CompetitiveError(failure);
}
