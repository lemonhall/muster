/**
 * 会话分片 / REST 层 → 匹配器 DO 的调用封装。
 *
 * 匹配器的键就是**租户 id**（每个租户一个池子），所以这里只有一处拼键；
 * 与频道/对局不同，它没有"第二个维度"，也就没有拼错键的空间。
 *
 * 业务失败（池子里的 `MatchmakerFailure`）原样回传：文案由管线决定
 * （`Error adding to matchmaker` / `Matchmaker ticket not found` 是两条不同的路）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerAdd
 *
 * REQ-0001-017
 */

import type { Bindings } from "../env";
import type { MatchmakerFailure } from "../domain/matchmaker/errors";
import type { MatchmakerCompletion } from "../domain/matchmaker/stats";
import type {
  MatchmakerAddInput,
  MatchmakerOpResult,
  MatchmakerRemoveInput,
  MatchmakerService,
} from "../realtime/matchmaker";

const FAILURES: readonly MatchmakerFailure[] = [
  "query-invalid",
  "duplicate-session",
  "too-many-tickets",
  "ticket-not-found",
  "not-available",
];

/**
 * 匹配器 DO 的通用调用入口。派对那一半（`party-delivery.ts` / `party-frame-ops.ts`）
 * 也要用同一条路，所以它是导出的——但**只有这一处拼键**这条规矩不变。
 */
export async function matchmakerCall(
  env: Bindings,
  tenantId: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(tenantId));
  const response = await stub.fetch(`https://matchmaker${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`匹配器调用失败：${path} -> ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function readFailure(raw: unknown): MatchmakerFailure {
  const failure = FAILURES.find((candidate) => candidate === raw);
  if (failure === undefined) throw new Error(`匹配器返回了无法识别的失败类型：${String(raw)}`);
  return failure;
}

export class SessionMatchmaker implements MatchmakerService {
  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
  ) {}

  async add(input: MatchmakerAddInput): Promise<MatchmakerOpResult> {
    const raw = await matchmakerCall(this.env, this.tenantId, "/add", input);
    if (raw["ok"] !== true) return { ok: false, failure: readFailure(raw["failure"]) };
    const ticket = raw["ticket"];
    if (typeof ticket !== "string") throw new Error("匹配器没有返回票号");
    return { ok: true, ticket };
  }

  async remove(input: MatchmakerRemoveInput): Promise<MatchmakerOpResult> {
    const raw = await matchmakerCall(this.env, this.tenantId, "/remove", input);
    if (raw["ok"] !== true) return { ok: false, failure: readFailure(raw["failure"]) };
    return { ok: true, ticket: input.ticket };
  }
}

export interface MatchmakerStatsDto {
  readonly ticketCount: number;
  readonly oldestTicketCreateTime: number | null;
  readonly completions: readonly MatchmakerCompletion[];
}

/** `GET /v2/matchmaker/stats` 的数据源。 */
export async function matchmakerStats(env: Bindings, tenantId: string): Promise<MatchmakerStatsDto> {
  const raw = await matchmakerCall(env, tenantId, "/stats", {});
  const ticketCount = raw["ticketCount"];
  const oldest = raw["oldestTicketCreateTime"];
  const completions = raw["completions"];
  if (typeof ticketCount !== "number" || !Array.isArray(completions)) {
    throw new Error("匹配器 stats 返回了无法识别的响应体");
  }
  return {
    ticketCount,
    oldestTicketCreateTime: typeof oldest === "number" ? oldest : null,
    completions: completions as readonly MatchmakerCompletion[],
  };
}

/** 连接关闭时的清票（上游 `sessionWS.Close` 里的 `RemoveSessionAll`）。 */
export async function matchmakerRemoveAll(
  env: Bindings,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await matchmakerCall(env, tenantId, "/removeAll", { sessionId });
}

/** 派对票的入参：整队一张票，票面归派对。 */
export interface MatchmakerPartyAddInput {
  readonly partyId: string;
  readonly presences: readonly {
    readonly userId: string;
    readonly sessionId: string;
    readonly username: string;
    readonly node: string;
  }[];
  readonly query: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple: number;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
}

export async function matchmakerAddParty(
  env: Bindings,
  tenantId: string,
  input: MatchmakerPartyAddInput,
): Promise<MatchmakerOpResult> {
  const raw = await matchmakerCall(env, tenantId, "/addParty", input);
  if (raw["ok"] !== true) return { ok: false, failure: readFailure(raw["failure"]) };
  const ticket = raw["ticket"];
  if (typeof ticket !== "string") throw new Error("匹配器没有返回票号");
  return { ok: true, ticket };
}

export async function matchmakerRemoveParty(
  env: Bindings,
  tenantId: string,
  partyId: string,
  ticket: string,
): Promise<MatchmakerOpResult> {
  const raw = await matchmakerCall(env, tenantId, "/removeParty", { partyId, ticket });
  if (raw["ok"] !== true) return { ok: false, failure: readFailure(raw["failure"]) };
  return { ok: true, ticket };
}

/** 成员变动 → 这个派对的所有票作废（上游 `RemovePartyAll`，幂等）。 */
export async function matchmakerRemovePartyAll(
  env: Bindings,
  tenantId: string,
  partyId: string,
): Promise<void> {
  await matchmakerCall(env, tenantId, "/removePartyAll", { partyId });
}
