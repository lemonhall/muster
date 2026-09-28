import type { Envelope } from "../../src/proto/realtime_pb";
import { e2eTenant } from "./global-setup";
import { accountOf, authenticateDevice, freshDeviceId } from "./http-helpers";
import { connectSocket, type WsClient } from "./ws-helpers";

/**
 * M7 E2E 的匹配/对局工装：开玩家、造请求、把帧拆成可断言的形状。
 *
 * 与 `tests/helpers/match-world.ts` 那份**刻意分开**：那份 import `cloudflare:test`
 * （能直接拿 DO stub、手工跑一轮成局），只能在测试池里跑；这份只能靠网络说话，
 * 所以它只做两件与运行环境无关的事——连真实 WebSocket、解码服务端推来的帧。
 *
 * 文件名不带 `.e2e.test.ts`，不会被 vitest 收集。
 */

export const ROUND_TRIP_MS = 20_000;
/** 成局要等匹配器的闹钟（E2E 是 200ms 一次），比单次往返宽松几倍。 */
const MATCH_MS = 60_000;

export interface Player {
  readonly token: string;
  readonly userId: string;
  readonly username: string;
  readonly socket: WsClient;
}

const connected: WsClient[] = [];

/** 用例收尾：把这一条用例开过的连接全关掉（分片会顺手清理它在对局/池子里的痕迹）。 */
export function closeSockets(): void {
  for (const socket of connected.splice(0)) socket.close();
}

export async function player(): Promise<Player> {
  const { session } = await authenticateDevice(e2eTenant, freshDeviceId("e2e-match"));
  const account = await accountOf(session.token);
  const user = account["user"] as { readonly id: string; readonly username: string };
  // `status=false`：这一组测的是匹配与对局，把状态订阅的噪声关掉。
  const socket = await connectSocket(session.token, { status: false });
  connected.push(socket);
  return { token: session.token, userId: user.id, username: user.username, socket };
}

/**
 * 每个用例一个全新的"匹配区间"。
 *
 * 为什么不用 `*`：本机的匹配器 DO 存储是**跨运行保留**的，`*` 的旧票会和新票配上，
 * 断言就退化成"我到底跟谁成了一局"的随机题。带唯一 `run` 属性的查询让这一轮的票
 * 只能和彼此成局——这正是上游 `properties.<key>:<value>` 子句的用法。
 */
export function freshRun(): { readonly query: string; readonly strings: Record<string, string> } {
  const run = crypto.randomUUID().replace(/-/gu, "");
  return { query: `properties.run:${run}`, strings: { run } };
}

export function presenceLabel(
  presence: { readonly userId: string; readonly username: string } | undefined,
): string {
  return presence === undefined ? "(无)" : `${presence.userId}/${presence.username}`;
}

function userIdOf(presence: { readonly userId: string } | undefined): string {
  return presence === undefined ? "" : presence.userId;
}

/** `matchmaker_add` 的回执：只带一个票号。 */
export async function ticketText(socket: WsClient, cid: string): Promise<string> {
  const frame = await socket.waitForFrame(
    (candidate) => candidate.cid === cid && candidate.message.case === "matchmakerTicket",
    ROUND_TRIP_MS,
  );
  if (frame.message.case !== "matchmakerTicket") throw new Error("unreachable");
  return frame.message.value.ticket;
}

export interface Matched {
  readonly token: string;
  readonly mid: string;
  readonly users: readonly string[];
  readonly selfUserId: string;
}

/** 解出 JWT 的 payload。**不验签**——验签是对局域的事，这里只钉 `mid` 与有效期的形状。 */
export function claimsOf(token: string): { readonly mid: string; readonly exp: number } {
  const segment = token.split(".")[1];
  if (segment === undefined) throw new Error(`不是三段式令牌：${token}`);
  const claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as {
    readonly mid?: unknown;
    readonly exp?: unknown;
  };
  if (typeof claims.mid !== "string" || typeof claims.exp !== "number") {
    throw new Error(`令牌缺少 mid/exp：${JSON.stringify(claims)}`);
  }
  return { mid: claims.mid, exp: claims.exp };
}

/** 等一帧 `matchmaker_matched`。E2E 不设钩子，所以走的一定是 token 分支。 */
export async function matched(socket: WsClient): Promise<Matched> {
  const frame = await socket.waitForFrame(
    (candidate) => candidate.message.case === "matchmakerMatched",
    MATCH_MS,
  );
  if (frame.message.case !== "matchmakerMatched") throw new Error("unreachable");
  const value = frame.message.value;
  if (value.id.case !== "token") {
    throw new Error(`E2E 没设钩子，成局帧该给 token，实际给了 ${value.id.case ?? "(空)"}`);
  }
  return {
    token: value.id.value,
    mid: claimsOf(value.id.value).mid,
    users: value.users.map((user) => presenceLabel(user.presence)),
    selfUserId: userIdOf(value.self?.presence),
  };
}

export interface MatchReply {
  readonly matchId: string;
  readonly authoritative: boolean;
  readonly label: string | undefined;
  readonly self: string;
  readonly presences: readonly string[];
}

export function matchReplyOf(envelope: Envelope): MatchReply | null {
  if (envelope.message.case !== "match") return null;
  const value = envelope.message.value;
  return {
    matchId: value.matchId,
    authoritative: value.authoritative,
    label: value.label,
    self: presenceLabel(value.self),
    presences: value.presences.map((presence) => presenceLabel(presence)),
  };
}

/** `match_join` / `match_create` 的回执（`match` 帧）。 */
export async function matchReply(socket: WsClient, cid: string): Promise<MatchReply> {
  const frame = await socket.waitForFrame(
    (candidate) => candidate.cid === cid && candidate.message.case === "match",
    ROUND_TRIP_MS,
  );
  const reply = matchReplyOf(frame);
  if (reply === null) throw new Error("unreachable");
  return reply;
}

export interface PresenceEvent {
  readonly matchId: string;
  readonly joins: readonly string[];
  readonly leaves: readonly string[];
}

export function presenceEventOf(envelope: Envelope): PresenceEvent | null {
  if (envelope.message.case !== "matchPresenceEvent") return null;
  const value = envelope.message.value;
  return {
    matchId: value.matchId,
    joins: value.joins.map((presence) => presenceLabel(presence)),
    leaves: value.leaves.map((presence) => presenceLabel(presence)),
  };
}

/**
 * 等一条**满足条件**的 `match_presence_event`（广播没有 cid，所以只能按内容挑；
 * 同一条连接上"有人加入"与"有人离开"是两条不同的事件）。
 */
export async function presenceEvent(
  socket: WsClient,
  wanted: (event: PresenceEvent) => boolean,
): Promise<PresenceEvent> {
  const frame = await socket.waitForFrame((candidate) => {
    const event = presenceEventOf(candidate);
    return event !== null && wanted(event);
  }, ROUND_TRIP_MS);
  const event = presenceEventOf(frame);
  if (event === null) throw new Error("unreachable");
  return event;
}

export interface LiveData {
  readonly matchId: string;
  readonly opCode: bigint;
  readonly text: string;
  readonly from: string;
  readonly reliable: boolean;
}

export function liveDataOf(envelope: Envelope): LiveData | null {
  if (envelope.message.case !== "matchData") return null;
  const value = envelope.message.value;
  return {
    matchId: value.matchId,
    opCode: value.opCode,
    text: new TextDecoder().decode(value.data),
    from: presenceLabel(value.presence),
    reliable: value.reliable ?? false,
  };
}
