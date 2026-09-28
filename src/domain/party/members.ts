/**
 * 派对成员表与加入请求表的**纯规则层**：给一份快照，回答"这次操作能不能做、
 * 做完之后谁进谁出"。SQL 只负责把决定落盘（`src/durable/party-members.ts`），
 * 于是每条校验规则**只有一处实现**，可以被逐条断言而不需要起一个 DO。
 *
 * 逐条对齐上游 `server/party_presence.go` 与 `server/party_handler.go`：
 *
 * - `Size()` = 成员 + 预留位（`Reserve` 占名额，`max_size` 不会被"正在进来的
 *   那个人"突破）；
 * - `Join` 只把**还不是成员**的人加进去（重复 join 不报错也不加人），唯一的失败
 *   原因是超出 `max_size`；
 * - `Oldest()` = 最早加入的那位（成员表的首元素），队长继任靠它；
 * - `Leave` 只对"真的在表里的人"生效，没在表里的会话原样忽略。
 *
 * 一处**刻意复刻的上游行为**：`JoinRequest` 里的"已经是成员了"这一条，上游查的是
 * `m.presenceMap[presence.UserID]`，而 `presenceMap` 的键其实是 **SessionID**
 * （`m.presenceMap[join.ID.SessionID] = join.ID.Node`）。两者只在这位用户的会话 id
 * 恰好等于他的用户 id 时才撞上，于是"已是成员"这条校验在上游实际上几乎不会触发——
 * 成员对私有派对再发一次 `party_join` 会**产生一条加入请求**。这里照抄，
 * 见 `decideJoinRequest` 里的注释。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_presence.go::PartyPresenceList.Reserve
 * 契约源: server/party_presence.go::PartyPresenceList.Join
 * 契约源: server/party_presence.go::PartyPresenceList.Leave
 * 契约源: server/party_handler.go::PartyHandler.JoinRequest
 *
 * REQ-0001-019
 */

import type { PartyFailureKind } from "./errors";
import type { PartyMemberEntry, PartyPresence, PartyRequestEntry } from "./types";

export type PartyDecision<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly kind: PartyFailureKind };

function refuse(kind: PartyFailureKind): { readonly ok: false; readonly kind: PartyFailureKind } {
  return { ok: false, kind };
}

/** 成员数 + 预留位（上游 `PartyPresenceList.Size()`）。 */
export function sizeOf(entries: readonly PartyMemberEntry[]): number {
  return entries.length;
}

/** 只数真成员：预留位不是成员，`party` 帧体里不该出现它们。 */
export function memberCountOf(entries: readonly PartyMemberEntry[]): number {
  let count = 0;
  for (const entry of entries) if (!entry.reserved) count += 1;
  return count;
}

export function realMembers(entries: readonly PartyMemberEntry[]): readonly PartyMemberEntry[] {
  return entries.filter((entry) => !entry.reserved);
}

/** 上游 `Oldest()`：`m.presences[0]`，也就是最早加入的那位真成员。 */
export function oldestOf(entries: readonly PartyMemberEntry[]): PartyMemberEntry | undefined {
  for (const entry of entries) if (!entry.reserved) return entry;
  return undefined;
}

export function findMember(
  entries: readonly PartyMemberEntry[],
  sessionId: string,
): PartyMemberEntry | undefined {
  return entries.find((entry) => entry.presence.sessionId === sessionId);
}

export function findRequest(
  requests: readonly PartyRequestEntry[],
  sessionId: string,
): PartyRequestEntry | undefined {
  return requests.find((entry) => entry.presence.sessionId === sessionId);
}

/**
 * 上游 `Reserve`：已经在预留表里就是幂等的成功；否则要过 `max_size`。
 * 这里不用真的记"预留表"——预留位就是成员表里的 `reserved = 1` 那一行。
 */
export function decideReserve(
  entries: readonly PartyMemberEntry[],
  maxSize: number,
  sessionId: string,
): { readonly ok: true; readonly alreadyReserved: boolean } | { readonly ok: false; readonly kind: PartyFailureKind } {
  const existing = findMember(entries, sessionId);
  if (existing !== undefined && existing.reserved) return { ok: true, alreadyReserved: true };
  if (sizeOf(entries) >= maxSize) return refuse("full");
  return { ok: true, alreadyReserved: false };
}

/**
 * 上游 `Join`：先数"真正的新人"，一次性判断容量，再把新人按顺序加进来。
 * 返回的 `added` 顺序 = 调用方给的顺序（上游也是这个顺序）。
 */
export function decideJoin(
  entries: readonly PartyMemberEntry[],
  maxSize: number,
  joins: readonly PartyPresence[],
): { readonly ok: true; readonly added: readonly PartyPresence[] } | { readonly ok: false; readonly kind: PartyFailureKind } {
  const known = new Set(entries.map((entry) => entry.presence.sessionId));
  const added: PartyPresence[] = [];
  for (const join of joins) {
    if (known.has(join.sessionId)) continue;
    added.push(join);
    known.add(join.sessionId);
  }
  // 上游：`len(reservedMap)+len(presenceMap)+newPresences > maxSize` —— 预留位是为
  // 这一批新人腾出来的，所以它们**不算**在超额的分子里（`entries` 已经含预留位，
  // 而预留的人就在 `added` 里，两边抵掉）。
  if (sizeOf(entries) + added.length > maxSize) return refuse("full");
  return { ok: true, added };
}

/** 上游 `Leave` 的返回值：真的被移除的那些人（没在表里的原样忽略）。 */
export function decideLeave(
  entries: readonly PartyMemberEntry[],
  sessionIds: readonly string[],
): readonly PartyPresence[] {
  const removed: PartyPresence[] = [];
  for (const sessionId of sessionIds) {
    const entry = findMember(entries, sessionId);
    if (entry === undefined) continue;
    if (removed.some((presence) => presence.sessionId === sessionId)) continue;
    removed.push(entry.presence);
  }
  return removed;
}

export interface JoinRequestDecision {
  /** true = 派对是开放的，直接进；false = 产生了一条待批的加入请求。 */
  readonly autoJoin: boolean;
}

/**
 * 上游 `PartyHandler.JoinRequest` 的校验顺序（顺序就是契约，抄错就会报错类型）：
 * 关闭 → 满员 → 开放则直接进 → 加入请求表满 → 重复请求 → 已是成员。
 */
export function decideJoinRequest(
  entries: readonly PartyMemberEntry[],
  requests: readonly PartyRequestEntry[],
  options: { readonly maxSize: number; readonly open: boolean },
  presence: PartyPresence,
): { readonly ok: true } & JoinRequestDecision | { readonly ok: false; readonly kind: PartyFailureKind } {
  if (sizeOf(entries) >= options.maxSize) return refuse("full");
  if (options.open) return { ok: true, autoJoin: true };
  if (requests.length >= options.maxSize) return refuse("join-requests-full");
  if (requests.some((entry) => entry.presence.userId === presence.userId)) {
    return refuse("join-request-duplicate");
  }
  // 上游这里查的是 `presenceMap[presence.UserID]`，而那张表的键是 SessionID：
  // 只有"会话 id 恰好等于用户 id"时才会命中。照抄，见文件头的说明。
  if (findMember(entries, presence.userId) !== undefined) {
    return refuse("join-request-already-member");
  }
  return { ok: true, autoJoin: false };
}

/** 上游 `Accept`：队长才能批 → 满员 → 请求必须在表里。 */
export function decideAccept(
  entries: readonly PartyMemberEntry[],
  requests: readonly PartyRequestEntry[],
  maxSize: number,
  presence: PartyPresence,
): { readonly ok: true; readonly request: PartyRequestEntry } | { readonly ok: false; readonly kind: PartyFailureKind } {
  if (sizeOf(entries) >= maxSize) return refuse("full");
  const request = requests.find(
    (entry) =>
      entry.presence.sessionId === presence.sessionId &&
      entry.presence.userId === presence.userId &&
      entry.presence.username === presence.username,
  );
  if (request === undefined) return refuse("not-request");
  return { ok: true, request };
}

/** 上游 `Promote`：只能提**已经在成员表里**的那位（三件套全比）。 */
export function decidePromote(
  entries: readonly PartyMemberEntry[],
  presence: PartyPresence,
): { readonly ok: true; readonly member: PartyMemberEntry } | { readonly ok: false; readonly kind: PartyFailureKind } {
  const member = entries.find(
    (entry) =>
      entry.presence.sessionId === presence.sessionId &&
      entry.presence.userId === presence.userId &&
      entry.presence.username === presence.username,
  );
  if (member === undefined) return refuse("not-member");
  return { ok: true, member };
}

/**
 * 上游 `Remove`：先看是不是成员（是 → 踢人 + 发 `party_close` 给被踢的人），
 * 不是成员再看是不是待批的加入请求（是 → 静默删掉，成功）。两者都不是 → not-member。
 * 队长不能踢自己（`remove-self`，在调用处先判）。
 */
export function decideRemove(
  entries: readonly PartyMemberEntry[],
  requests: readonly PartyRequestEntry[],
  presence: PartyPresence,
): { readonly ok: true; readonly outcome: "member" | "request" } | { readonly ok: false; readonly kind: PartyFailureKind } {
  const member = entries.find(
    (entry) =>
      entry.presence.sessionId === presence.sessionId &&
      entry.presence.userId === presence.userId &&
      entry.presence.username === presence.username,
  );
  if (member !== undefined) return { ok: true, outcome: "member" };
  const request = requests.find(
    (entry) =>
      entry.presence.sessionId === presence.sessionId &&
      entry.presence.userId === presence.userId &&
      entry.presence.username === presence.username,
  );
  if (request !== undefined) return { ok: true, outcome: "request" };
  return refuse("not-member");
}

/** 上游 `DataSend`：发送者必须在成员表里（按会话 + 节点比），否则 not-member。 */
export function findSender(
  entries: readonly PartyMemberEntry[],
  sessionId: string,
  node: string,
): PartyMemberEntry | undefined {
  return entries.find(
    (entry) => entry.presence.sessionId === sessionId && entry.presence.node === node,
  );
}
