/**
 * 一轮成局之后要做的事：决定目标、投递 `matchmaker_matched`、记账。
 *
 * 上游这一段在 `LocalMatchmaker.Process` 的尾部：每个成局组起一个 goroutine，
 * 问一次运行时回调，没拿到 match id 就签一个 30 秒的 token，然后**给组里每个人各发一份
 * 帧**（`self` 与 `ticket` 是逐人不同的）。这里逐条照抄，只把"起 goroutine"换成顺序执行——
 * 结果一样，而顺序投递让"谁先收到"这件事在测试里也确定。
 *
 * 三项记账跟上游一致：
 * 1. 成局的票从池子里摘掉（`delete(m.indexes, ...)`）；
 * 2. 每收到一份帧就往完成缓冲里塞一条（上游是**按人**塞的，不是按局）；
 * 3. `matchmaker_matched` 的 `users` **含收件人自己**，`self` 是收件人那一份。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Process
 *
 * REQ-0001-017
 */

import type { Bindings } from "../env";
import type { MatchmakerPool } from "../domain/matchmaker/pool";
import { processPool } from "../domain/matchmaker/process";
import type { CompletionBuffer } from "../domain/matchmaker/stats";
import type { MatchmakerEntry } from "../domain/matchmaker/types";
import { LOCAL_NODE } from "../domain/match/ids";
import { signMatchToken } from "../domain/match/token";
import { uuidV4 } from "../domain/uuid";
import {
  matchmakerMatchedEnvelope,
  type MatchmakerMatchedUser,
  type MatchmakerTarget,
} from "../realtime/matchmaker";
import { deliverToSession } from "./delivery";
import { matchCreate } from "./match-call";
import { hookMatches, type MatchedHook } from "./matchmaker-hook";

export interface ProcessRound {
  /** 这一轮成了几局。 */
  readonly matches: number;
  /** 这一轮摘掉的票。 */
  readonly tickets: readonly string[];
}

function userOf(entry: MatchmakerEntry): MatchmakerMatchedUser {
  return {
    userId: entry.presence.userId,
    sessionId: entry.presence.sessionId,
    username: entry.presence.username,
    partyId: entry.partyId,
    stringProperties: entry.stringProperties,
    numericProperties: entry.numericProperties,
  };
}

/** 跑一轮并把结果发出去；返回成了几局、摘了哪些票（调用方负责落盘与排下一次闹钟）。 */
export async function processRound(
  env: Bindings,
  tenantId: string,
  pool: MatchmakerPool,
  completions: CompletionBuffer,
  hook: MatchedHook | null,
  options: { readonly now: number; readonly mutualMatchBudgetMs: number },
): Promise<ProcessRound> {
  const { matches } = processPool(pool, {
    now: options.now,
    mutualMatchBudgetMs: options.mutualMatchBudgetMs,
  });
  const tickets: string[] = [];
  for (const group of matches) {
    for (const index of group) tickets.push(index.ticket);
    const entries = group.flatMap((index) => index.entries);
    const target = await resolveTarget(env, tenantId, hook, entries, options.now);
    const users = entries.map(userOf);
    for (const entry of entries) {
      // 上游是"按人"记一条完成样本（同一局里每个人各一条），这里照抄。
      completions.insert({ createdAt: entry.createTime, completedAt: options.now });
      await deliverToSession(
        env,
        tenantId,
        entry.presence.sessionId,
        matchmakerMatchedEnvelope(target, entry.ticket, users, userOf(entry)),
      ).catch((error: unknown) => {
        // 某个人刚好断线是正常的：成局结果已经定了，投递失败不该回滚整局。
        console.error("成局帧投递失败", error);
      });
    }
  }
  pool.remove(tickets);
  return { matches: matches.length, tickets };
}

/**
 * 目标解析：钩子点头就**开一场权威对局**并给出它的 id，否则签一个中继令牌。
 *
 * 开对局走 `matchCreate`（对局 DO 的 `/create`），于是权威对局在成局之前就存在，
 * 客户端拿到 match id 之后直接 `match_join` 就能进——正是 DoD 8 钉的那条链。
 */
async function resolveTarget(
  env: Bindings,
  tenantId: string,
  hook: MatchedHook | null,
  entries: readonly MatchmakerEntry[],
  now: number,
): Promise<MatchmakerTarget> {
  const uuid = uuidV4();
  if (hook !== null && hookMatches(hook, entries)) {
    await matchCreate(env, tenantId, uuid, {
      authoritative: true,
      label: hook.label ?? "",
      node: LOCAL_NODE,
    });
    return { kind: "matchId", value: `${uuid}.${LOCAL_NODE}` };
  }
  const mid = `${uuid}.`;
  const token = await signMatchToken(env, tenantId, mid, Math.floor(now / 1000));
  return { kind: "token", value: token };
}
