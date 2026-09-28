/**
 * 对局 id 的形状。
 *
 * 上游的 match id 是 `<uuid>.<node>`：点号后面是"这个对局在哪个节点上"。
 * 客户端只把它当不透明字符串用，但**服务端**要能从它分辨两种对局
 * （`pipeline_match.go` 的 `matchIDComponents[1] != ""` 就是那个判断）：
 *
 * - 空 node（`<uuid>.`）→ 中继对局（relayed）：所有客户端在**彼此之间**转发数据，
 *   服务端只做路由；
 * - 非空 node（`<uuid>.<node>`）→ 权威对局（authoritative）：服务端跑 tick 循环。
 *
 * 本项目每租户只有一个逻辑节点，node 段固定是 `muster`（ECN-0011 偏差 6）。
 * 解析时仍然接受任意非空 node——发布出去的 `matchmaker_matched.token` 里的 mid 是
 * `<uuid>.`（空 node，与上游一致），客户端拿它回来时必须能解析。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchLeave
 *
 * REQ-0001-018
 */

/** 本项目唯一的逻辑节点名。上游每个进程有自己的 node 名。 */
export const LOCAL_NODE = "muster";

export interface MatchIdParts {
  /** 小写标准形的 uuid。 */
  readonly uuid: string;
  /** 点号后面的节点名；空串表示中继对局。 */
  readonly node: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 解析 match id。上游要求"点号恰好把它切成两段、前半段是 uuid"，
 * 两条不满足都是 `Invalid match ID`——这里返回 `null`，由调用方给文案。
 */
export function parseMatchId(raw: string): MatchIdParts | null {
  const separator = raw.indexOf(".");
  if (separator <= 0) return null;
  const uuid = raw.slice(0, separator).toLowerCase();
  if (!UUID_RE.test(uuid)) return null;
  return { uuid, node: raw.slice(separator + 1) };
}

/** 拼出对外可见的 match id。 */
export function formatMatchId(uuid: string, node = LOCAL_NODE): string {
  return `${uuid}.${node}`;
}

/** 权威对局：node 段非空。 */
export function isAuthoritativeMatch(parts: MatchIdParts): boolean {
  return parts.node !== "";
}

/**
 * 权威对局的 DO 名：`租户|uuid`。
 *
 * 为什么带租户：不同租户的 match id 可能撞（uuid 是随机的，但"撞了要能隔离"
 * 是硬要求，不能靠概率）。DO 的实例名就是隔离边界（ECN-0001）。
 */
export function matchKeyOf(tenantId: string, uuid: string): string {
  return `${tenantId}|${uuid}`;
}
