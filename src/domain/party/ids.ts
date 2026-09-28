/**
 * 派对 id 的形状：`<uuid>.<node>`。
 *
 * 与对局 id 同形（`match/ids.ts`），差别只在语义：对局 id 的 node 段区分"中继 /
 * 权威"，派对 id 的 node 段是"派对住在哪个节点上"——上游单进程就是本机节点名，
 * 多进程时靠它把请求路由到持有该派对的进程。本项目每租户只有一个逻辑节点，
 * 段值固定 `muster`（与 ECN-0011 偏差 6 同一条处置）。
 *
 * 上游对非法形状只回一条文案 `Invalid party ID`：切不出两段、或者前半段不是
 * uuid，都是同一条。这里返回 `null`，文案由管线给。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyJoin
 * 契约源: server/pipeline_party.go::Pipeline.partyLeave
 *
 * REQ-0001-019
 */

import { LOCAL_NODE } from "../match/ids";

export interface PartyIdParts {
  /** 小写标准形的 uuid。 */
  readonly uuid: string;
  /** 点号后面的节点名；非空。 */
  readonly node: string;
}

export { LOCAL_NODE };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function parsePartyId(raw: string): PartyIdParts | null {
  const separator = raw.indexOf(".");
  if (separator <= 0) return null;
  const uuid = raw.slice(0, separator).toLowerCase();
  if (!UUID_RE.test(uuid)) return null;
  return { uuid, node: raw.slice(separator + 1) };
}

export function formatPartyId(uuid: string, node = LOCAL_NODE): string {
  return `${uuid}.${node}`;
}

/** 派对 DO 的实例名：`租户|uuid`（DO 的实例名就是隔离边界，ECN-0001）。 */
export function partyKeyOf(tenantId: string, uuid: string): string {
  return `${tenantId}|${uuid}`;
}
