/**
 * 派对的领域类型：成员、加入请求、目录条目，以及目录查询的游标。
 *
 * 上游派对状态全部住在进程内存里（`LocalPartyRegistry` 的 map + 每个 `PartyHandler`
 * 的成员表 / 加入请求切片），进程重启即丢。本项目把它放进**每个派对一个 DO** 的
 * SQLite（ECN-0013 偏差 1），于是"重启后派对还在"是我们的行为，不是上游的行为——
 * 这条差异记在 ECN 里，测试不依赖它。
 *
 * 目录条目的字段与上游 bluge 文档逐个对应（`MapPartyIndexEntry`）：
 * `node` / `open` / `hidden` / `max_size` / `create_time` 各一列，标签按 `label.<key>`
 * 摊平成可查询字段。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::PartyIndexEntry
 * 契约源: server/party_registry.go::MapPartyIndexEntry
 *
 * REQ-0001-019
 */

/** 派对成员的一条 presence。三件套与上游 `rtapi.UserPresence` 对齐。 */
export interface PartyPresence {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  /** 该 presence 所在的节点（本项目恒为 `muster`）。 */
  readonly node: string;
}

/** 目录条目：`GET /v2/party` 的一行。 */
export interface PartyRecord {
  /** `<uuid>.<node>`，对外可见的派对 id。 */
  readonly partyId: string;
  readonly uuid: string;
  readonly node: string;
  readonly open: boolean;
  readonly hidden: boolean;
  readonly maxSize: number;
  /** 标签原始 JSON 串；上游在创建时把空串规整成 `{}`。 */
  readonly label: string;
  /** 创建时间，Unix 秒。 */
  readonly createTime: number;
}

export interface PartyListFilters {
  readonly limit: number;
  /** `undefined` = 不按开放/关闭过滤。 */
  readonly open: boolean | undefined;
  readonly query: string | undefined;
  /** 游标里的偏移量；`undefined` = 第一页。 */
  readonly offset: number | undefined;
}

export interface PartyListPage {
  readonly parties: readonly PartyRecord[];
  /** 还有下一页时的游标（base64url(JSON)）；没有更多就是空串。 */
  readonly cursor: string;
}

/**
 * 成员表里的一行：presence 三件套 + "是不是预留位" + 进入顺序。
 *
 * 为什么预留位要单独成标志：上游 `PartyPresenceList.Reserve` 把"已被接受但还没进流"
 * 的人放进 `reservedMap`，而 `Size()` 数的是 `presenceMap + reservedMap`。于是
 * `max_size` 不会被"正在进来的那个人"突破，而 `List()`（对外广播的 `presences`）
 * 里**看不到**预留位。把这件事表达成一行数据而不是两套表，SQL 层就只需要一张表。
 */
export interface PartyMemberEntry {
  readonly presence: PartyPresence;
  /** true = 预留位（占名额、不进 `presences`）。 */
  readonly reserved: boolean;
  /** 进入顺序：自增整数，先到先得。上游的顺序就是数组插入顺序。 */
  readonly seq: number;
}

/** 加入请求表里的一行。顺序同样由自增序号定。 */
export interface PartyRequestEntry {
  readonly presence: PartyPresence;
  readonly seq: number;
}

/** 标签长度上限（上游 `PartyLabelMaxBytes`），单位字节。 */
export const PARTY_LABEL_MAX_BYTES = 2048;

/** 成员数上限（上游 `partyCreate` 里那条 `must be 1-256` 的校验）。 */
export const PARTY_MAX_SIZE_LIMIT = 256;
