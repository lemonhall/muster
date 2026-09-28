import { parsePartyId } from "../../src/domain/party/ids";
import type { Envelope, UserPresence } from "../../src/proto/realtime_pb";
import { e2eTenant } from "./global-setup";
import { accountOf, authenticateDevice, freshDeviceId } from "./http-helpers";
import { connectSocket, type WsClient } from "./ws-helpers";

/**
 * M8 E2E 的派对工装：开玩家、发一帧等回执、把广播帧拆成可断言的形状。
 *
 * 与 `tests/helpers/party-world.ts` 那份**刻意分开**：那份 import `cloudflare:test`
 * （随机租户 + 直接拿 DO stub），只能在测试池里跑；这份只能靠网络说话，所以它只做
 * 与运行环境无关的事——连真实 WebSocket、解码服务端推来的帧。
 *
 * 文件名不带 `.e2e.test.ts`，不会被 vitest 收集。
 */

export const ROUND_TRIP_MS = 20_000;

export interface PartyPlayer {
  readonly token: string;
  readonly userId: string;
  readonly username: string;
  readonly socket: WsClient;
}

const connected: WsClient[] = [];

/** 用例收尾：把这一条用例开过的连接全关掉（分片会顺手把它从派对里摘掉）。 */
export function closeSockets(): void {
  for (const socket of connected.splice(0)) socket.close();
}

export async function partyPlayer(): Promise<PartyPlayer> {
  const { session } = await authenticateDevice(e2eTenant, freshDeviceId("e2e-party"));
  const account = await accountOf(session.token);
  const user = account["user"] as { readonly id: string; readonly username: string };
  // `status=false`：这一组测的是派对，把状态订阅的噪声关掉。
  const socket = await connectSocket(session.token, { status: false });
  connected.push(socket);
  return { token: session.token, userId: user.id, username: user.username, socket };
}

/** 发一帧并等 cid 相同的回执。 */
export async function ask(socket: WsClient, envelope: Envelope): Promise<Envelope> {
  socket.send(envelope);
  return await socket.waitForFrame((frame) => frame.cid === envelope.cid, ROUND_TRIP_MS);
}

/** 从 `party` 回执里取派对 id 与它的 uuid。 */
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
export async function waitForKind(socket: WsClient, kind: string): Promise<Envelope> {
  return await socket.waitForFrame((frame) => frame.message.case === kind, ROUND_TRIP_MS);
}

/**
 * 等一帧**还没收到过的**某类型帧。
 *
 * 有些回帧不带 cid（上游只把调用方原样给的 id 塞进回帧），于是"这一帧是刚才那次
 * 请求的答复"只能靠"它是新来的"来判定——帧列表是历史，同一类型更早的帧会先被命中。
 */
export async function waitForNewKind(socket: WsClient, kind: string): Promise<Envelope> {
  const seen = new Set(socket.frames);
  return await socket.waitForFrame(
    (frame) => !seen.has(frame) && frame.message.case === kind,
    ROUND_TRIP_MS,
  );
}

export function sessionsOf(presences: readonly UserPresence[]): string[] {
  return presences.map((presence) => presence.sessionId);
}

/**
 * 等一条**成员是给定那些人**的 `party_presence_event`。
 *
 * 帧列表是历史，一条会话先后收到过好几条事件，只按类型找会命中最早的那条；
 * 这里按 joins/leaves 的会话 id 精确定位。
 */
export async function waitForPresence(
  socket: WsClient,
  expected: { readonly joins?: readonly string[]; readonly leaves?: readonly string[] },
): Promise<Envelope> {
  const wantJoins = expected.joins ?? [];
  const wantLeaves = expected.leaves ?? [];
  const same = (actual: readonly UserPresence[], want: readonly string[]): boolean =>
    sessionsOf(actual).join(",") === want.join(",");
  return await socket.waitForFrame(
    (frame) =>
      frame.message.case === "partyPresenceEvent" &&
      same(frame.message.value.joins, wantJoins) &&
      same(frame.message.value.leaves, wantLeaves),
    ROUND_TRIP_MS,
  );
}

/** 负向断言：先钉住基线条数，再等一个有界窗口比条数（帧列表是历史，不能只看有没有）。 */
export async function expectNoNewFrame(
  socket: WsClient,
  predicate: (frame: Envelope) => boolean,
  windowMs = 1000,
): Promise<void> {
  const before = socket.frames.filter(predicate).length;
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const matched = socket.frames.filter(predicate);
  if (matched.length !== before) {
    const last = matched[matched.length - 1];
    throw new Error(`本不该再收到这帧：${last?.message.case ?? "(空)"}`);
  }
}
