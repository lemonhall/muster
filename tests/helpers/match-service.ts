import type {
  MatchCreateInput,
  MatchDataSendInput,
  MatchJoinInput,
  MatchLeaveInput,
  MatchOpResult,
  MatchService,
} from "../../src/realtime/match";
import type {
  MatchmakerAddInput,
  MatchmakerOpResult,
  MatchmakerRemoveInput,
  MatchmakerService,
} from "../../src/realtime/matchmaker";

/**
 * M7 实时套件的假服务：把调用原样记下来，回一个可控的结果。
 *
 * 与 `recordingChannel` 同一个理由——管线这一层要断言的是**校验顺序与错误码**
 * （上游 `pipeline_match.go` / `pipeline_matchmaker.go`），而"谁在池子里、谁在对局里"
 * 是 Durable Object 的职责。真 DO 的语义在 `tests/integration/match/` 与
 * `tests/integration/matchmaker/` 里另测。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集（见 `vitest.config.ts` 的 include）。
 */

export interface RecordedMatchmaker {
  readonly service: MatchmakerService;
  readonly adds: MatchmakerAddInput[];
  readonly removes: MatchmakerRemoveInput[];
  /** 下一次 `add` 的返回值；默认"成功，票号 t1"。 */
  addResult: MatchmakerOpResult;
  /** 下一次 `remove` 的返回值；默认"成功，票号 t1"。 */
  removeResult: MatchmakerOpResult;
}

export function recordingMatchmaker(
  addResult: MatchmakerOpResult = { ok: true, ticket: "t1" },
  removeResult: MatchmakerOpResult = { ok: true, ticket: "t1" },
): RecordedMatchmaker {
  const adds: MatchmakerAddInput[] = [];
  const removes: MatchmakerRemoveInput[] = [];
  const holder: RecordedMatchmaker = {
    adds,
    removes,
    addResult,
    removeResult,
    service: {
      async add(input) {
        adds.push(input);
        return holder.addResult;
      },
      async remove(input) {
        removes.push(input);
        return holder.removeResult;
      },
    },
  };
  return holder;
}

export interface RecordedMatch {
  readonly service: MatchService;
  readonly creates: MatchCreateInput[];
  readonly joins: MatchJoinInput[];
  readonly leaves: MatchLeaveInput[];
  readonly sends: MatchDataSendInput[];
  readonly tokens: string[];
  /** `create` / `join` / `leave` / `dataSend` 共用的返回值；默认"成功但没有任何回帧"。 */
  result: MatchOpResult;
  /** `resolveToken` 的返回值；默认解不出任何东西（null）。 */
  tokenResult: string | null;
}

export function recordingMatch(result: MatchOpResult = { ok: true, replies: [] }): RecordedMatch {
  const creates: MatchCreateInput[] = [];
  const joins: MatchJoinInput[] = [];
  const leaves: MatchLeaveInput[] = [];
  const sends: MatchDataSendInput[] = [];
  const tokens: string[] = [];
  const holder: RecordedMatch = {
    creates,
    joins,
    leaves,
    sends,
    tokens,
    result,
    tokenResult: null,
    service: {
      async resolveToken(token) {
        tokens.push(token);
        return holder.tokenResult;
      },
      async create(input) {
        creates.push(input);
        return holder.result;
      },
      async join(input) {
        joins.push(input);
        return holder.result;
      },
      async leave(input) {
        leaves.push(input);
        return holder.result;
      },
      async dataSend(input) {
        sends.push(input);
        return holder.result;
      },
    },
  };
  return holder;
}
