import { env } from "cloudflare:test";

import { partyKeyOf, parsePartyId } from "../../src/domain/party/ids";
import type { Envelope, UserPresence } from "../../src/proto/realtime_pb";
import { shardKeyOf } from "../../src/realtime/socket-meta";
import { CALLER_ID, CALLER_USERNAME, PEER_ID, PEER_USERNAME, insertUser } from "./realtime";
import { THIRD_ID, THIRD_USERNAME } from "./match-world";
import { delay, openSocket, sendFrame, waitForFrame, type TestSocket } from "./realtime-socket";
import { createTenant } from "./tenants";

/**
 * M8 派对套件的工装：一个随机租户 + 三个账号 + 若干条**真** WebSocket。
 *
 * 每个用例一个随机租户，于是每个派对 DO 都是全新的（分片键里带租户）；
 * 帧走真实编码（`sendFrame`）而不是手拼 JSON，于是"发出去的东西真的是那个帧"
 * 也被覆盖到了。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export const OWNER = { id: CALLER_ID, username: CALLER_USERNAME };
export const GUEST = { id: PEER_ID, username: PEER_USERNAME };
export const SPARE = { id: THIRD_ID, username: THIRD_USERNAME };

export interface PartyWorld {
  readonly tenant: string;
  readonly serverKey: string;
  /** 开一条真 WebSocket；`sessionId` 由调用方决定（默认取 `s1` 这样的小名字）。 */
  open(sessionId: string, who: { readonly id: string; readonly username: string }): Promise<TestSocket>;
  party(uuid: string): DurableObjectStub;
  matchmaker(): DurableObjectStub;
  closeAll(): Promise<void>;
}

export async function partyWorld(): Promise<PartyWorld> {
  const tenant = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenant}`;
  await createTenant(tenant, serverKey, "party");
  for (const who of [OWNER, GUEST, SPARE]) await insertUser(tenant, who.id, who.username);

  const sockets: TestSocket[] = [];
  const world: PartyWorld = {
    tenant,
    serverKey,
    async open(sessionId, who) {
      const socket = await openSocket(tenant, sessionId, who.id, who.username, { wantsStatus: false });
      sockets.push(socket);
      return socket;
    },
    party: (uuid) => env.PARTY.get(env.PARTY.idFromName(partyKeyOf(tenant, uuid))),
    matchmaker: () => env.MATCHMAKER.get(env.MATCHMAKER.idFromName(tenant)),
    async closeAll() {
      const opened = sockets.splice(0);
      for (const socket of opened) socket.close();
      await delay(50);
    },
  };
  return world;
}

/** 发一帧并等 cid 相同的回执。 */
export async function ask(target: TestSocket, envelope: Envelope): Promise<Envelope> {
  sendFrame(target, envelope);
  return await waitForFrame(target, (frame) => frame.cid === envelope.cid);
}

/** 从 `party` 回执里取派对 id 与它的 uuid（后续要拿它去要 DO stub）。 */
export function partyIdOf(envelope: Envelope): { readonly partyId: string; readonly uuid: string } {
  if (envelope.message.case !== "party") {
    throw new Error(`期望一帧 party，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const partyId = envelope.message.value.partyId;
  const parts = parsePartyId(partyId);
  if (parts === null) throw new Error(`回执里的派对 id 形状不对：${partyId}`);
  return { partyId, uuid: parts.uuid };
}

/** 无 cid 的广播帧（presence 事件 / leader / close）要靠类型找。 */
export function firstOfKind(target: TestSocket, kind: string): Envelope | undefined {
  return target.frames.find((frame) => frame.message.case === kind);
}

export async function waitForKind(target: TestSocket, kind: string, timeoutMs = 3000): Promise<Envelope> {
  return await waitForFrame(target, (frame) => frame.message.case === kind, timeoutMs);
}

/**
 * 等一条**成员是给定那些人**的 `party_presence_event`。
 *
 * 为什么不能只用 `waitForKind`：帧列表是历史，一条会话先后收到过"某人加入"的
 * 好几条事件，按类型找会命中最早的那条。这里按 joins/leaves 的会话 id 精确定位。
 */
export async function waitForPresence(
  target: TestSocket,
  expected: { readonly joins?: readonly string[]; readonly leaves?: readonly string[] },
  timeoutMs = 3000,
): Promise<Envelope> {
  const wantJoins = expected.joins ?? [];
  const wantLeaves = expected.leaves ?? [];
  const same = (actual: readonly UserPresence[], want: readonly string[]): boolean =>
    actual.map((one) => one.sessionId).join(",") === want.join(",");
  return await waitForFrame(
    target,
    (frame) =>
      frame.message.case === "partyPresenceEvent" &&
      same(frame.message.value.joins, wantJoins) &&
      same(frame.message.value.leaves, wantLeaves),
    timeoutMs,
  );
}

/** 分片键：测试里偶尔要直接问分片"这个会话还在不在"。 */
export function shardOf(tenant: string, sessionId: string): DurableObjectStub {
  return env.SESSION_SHARD.get(env.SESSION_SHARD.idFromName(shardKeyOf(tenant, sessionId)));
}
