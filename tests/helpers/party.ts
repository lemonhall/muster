import type {
  PartyActor,
  PartyCloseInput,
  PartyCreateInput,
  PartyDataInput,
  PartyJoinInput,
  PartyJoinRequestListInput,
  PartyMatchmakerAddRequest,
  PartyMatchmakerRemoveInput,
  PartyOpFailure,
  PartyOpResult,
  PartyService,
  PartyUpdateInput,
} from "../../src/realtime/party";

/**
 * M8 实时套件的假派对服务：把调用原样记下来，回一个可控的结果。
 *
 * 与 `recordingChannel` / `recordingMatch` 同一个理由——管线这一层要断言的是
 * **校验顺序与错误文案**（上游 `pipeline_party.go`），而"谁在派对里、谁是队长"
 * 是 Durable Object 的职责。真 DO 的语义在 `tests/integration/party/` 里另测。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集（见 `vitest.config.ts` 的 include）。
 */

export interface RecordedParty {
  readonly service: PartyService;
  readonly creates: PartyCreateInput[];
  readonly joins: PartyJoinInput[];
  readonly leaves: PartyCloseInput[];
  readonly promotes: PartyActor[];
  readonly accepts: PartyActor[];
  readonly removes: PartyActor[];
  readonly closes: PartyCloseInput[];
  readonly requestLists: PartyJoinRequestListInput[];
  readonly dataSends: PartyDataInput[];
  readonly updates: PartyUpdateInput[];
  readonly matchmakerAdds: PartyMatchmakerAddRequest[];
  readonly matchmakerRemoves: PartyMatchmakerRemoveInput[];
  readonly leaveAlls: string[];
  /** 下一次改状态操作的返回值；默认"成功但没有任何回帧"。 */
  result: PartyOpResult;
  /** 把 result 换成失败（方便一条用例只改一处）。 */
  failWith(failure: PartyOpFailure): void;
}

export function recordingParty(result: PartyOpResult = { ok: true, replies: [] }): RecordedParty {
  const creates: PartyCreateInput[] = [];
  const joins: PartyJoinInput[] = [];
  const leaves: PartyCloseInput[] = [];
  const promotes: PartyActor[] = [];
  const accepts: PartyActor[] = [];
  const removes: PartyActor[] = [];
  const closes: PartyCloseInput[] = [];
  const requestLists: PartyJoinRequestListInput[] = [];
  const dataSends: PartyDataInput[] = [];
  const updates: PartyUpdateInput[] = [];
  const matchmakerAdds: PartyMatchmakerAddRequest[] = [];
  const matchmakerRemoves: PartyMatchmakerRemoveInput[] = [];
  const leaveAlls: string[] = [];

  const holder: RecordedParty = {
    creates,
    joins,
    leaves,
    promotes,
    accepts,
    removes,
    closes,
    requestLists,
    dataSends,
    updates,
    matchmakerAdds,
    matchmakerRemoves,
    leaveAlls,
    result,
    failWith(failure) {
      holder.result = { ok: false, failure };
    },
    service: {
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
      async promote(input) {
        promotes.push(input);
        return holder.result;
      },
      async accept(input) {
        accepts.push(input);
        return holder.result;
      },
      async remove(input) {
        removes.push(input);
        return holder.result;
      },
      async close(input) {
        closes.push(input);
        return holder.result;
      },
      async joinRequestList(input) {
        requestLists.push(input);
        return holder.result;
      },
      async dataSend(input) {
        dataSends.push(input);
        return holder.result;
      },
      async update(input) {
        updates.push(input);
        return holder.result;
      },
      async matchmakerAdd(input) {
        matchmakerAdds.push(input);
        return holder.result;
      },
      async matchmakerRemove(input) {
        matchmakerRemoves.push(input);
        return holder.result;
      },
      async leaveAll(sessionId) {
        leaveAlls.push(sessionId);
      },
    },
  };
  return holder;
}
