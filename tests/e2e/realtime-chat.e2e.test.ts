import { afterEach, describe, expect, it } from "vitest";

import {
  channelHistoryPath,
  channelJoin,
  channelMessageOf,
  channelMessageSend,
  channelReply,
  liveMessages,
  roomChannelId,
  roomOf,
  type JoinReply,
  type LiveMessage,
} from "./channel-helpers";
import { e2eTenant } from "./global-setup";
import { accountOf, authenticateDevice, call, freshDeviceId } from "./http-helpers";
import { connectSocket, type WsClient } from "./ws-helpers";

/**
 * M4 E2E：频道与聊天，走真实 `wrangler dev --local` 进程上的真 WebSocket + 真 HTTP。
 *
 * 与 `tests/integration/channel/` 的分工：那边直接拿 DO stub，验的是频道语义（谁在频道里、
 * 谁能改删、游标怎么翻页）；这里两端都是网络上的真连接，验的是**整条链在真实进程里成立**——
 * 路由、握手、分片 DO 的 WebSocket 升级、频道 DO 的广播、以及历史走 REST 时那套 protojson 线格式。
 *
 * 目标进程是本机 workerd（见 `global-setup.ts`），不连任何 Cloudflare 账号资源。
 *
 * 时间预算：本地 dev 的 ProxyWorker 每个往返都有固定开销（M2 Review 记的是约 1.4s/请求），
 * 所以"两个客户端 + 十条消息 + 读历史"这种用例要按分钟给预算，不能沿用 30s 默认值。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageSend
 * 契约源: server/core_channel.go::ChannelMessagesList
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/channel/{channelId}
 *
 * REQ-0001-010
 */

interface Player {
  readonly token: string;
  readonly userId: string;
  readonly username: string;
  readonly socket: WsClient;
}

interface HistoryMessage {
  readonly message_id: string;
  readonly channel_id: string;
  readonly sender_id: string;
  readonly username: string;
  readonly content: string;
  readonly persistent: boolean;
  readonly room_name: string;
}

interface HistoryBody {
  readonly messages?: readonly HistoryMessage[];
}

const ROUND_TRIP_MS = 20_000;

const connected: WsClient[] = [];

afterEach(() => {
  for (const socket of connected.splice(0)) socket.close();
});

async function player(): Promise<Player> {
  const { session } = await authenticateDevice(e2eTenant, freshDeviceId("e2e-chat"));
  const account = await accountOf(session.token);
  const user = account["user"] as { readonly id: string; readonly username: string };
  // `status=false`：这一组测的是频道，把状态订阅的噪声关掉，失败信息里只剩频道帧。
  const socket = await connectSocket(session.token, { status: false });
  connected.push(socket);
  return { token: session.token, userId: user.id, username: user.username, socket };
}

/**
 * 每个用例一个新房间名：本地 D1 与 DO 存储是**跨运行保留**的，固定房间名会让
 * "历史里正好 10 条"这种断言偷偷依赖上一轮跑过。
 */
function freshRoom(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function join(
  socket: WsClient,
  cid: string,
  room: string,
  options: { readonly persistence?: boolean } = {},
): Promise<JoinReply> {
  socket.send(channelJoin(cid, room, 1, options));
  return channelReply(
    await socket.waitForFrame(
      (frame) => frame.cid === cid && frame.message.case === "channel",
      ROUND_TRIP_MS,
    ),
  );
}

/** 等这条连接攒够 `count` 条广播；不够就把"现在有几条"写进错误里，别只说超时。 */
async function waitForMessages(client: Player, count: number): Promise<LiveMessage[]> {
  const deadline = Date.now() + ROUND_TRIP_MS;
  while (Date.now() < deadline) {
    const seen = liveMessages(client.socket.frames);
    if (seen.length >= count) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${client.username} 只收到 ${liveMessages(client.socket.frames).length} 条广播，期望 ${count} 条`);
}

/**
 * 两个客户端在同一个房间里交替发 `count` 条：每条都等**发送者**收到自己那条广播才发下一条。
 *
 * 为什么"等发送者"就够：频道 DO 的 `send` 在回帧之前已经把广播扇出给其他成员并 await 完了
 * （`channel-core.ts` 里 `#fanout.send` 在 `replies` 之前），所以发送者看到自己那条广播时，
 * 顺序已经由那个 DO 单点定下来了。发完再统一等两边攒齐，能把绝大多数往返省掉。
 *
 * 内容一律是 JSON **对象**的文本：上游要求 `json.Valid` 且首字节是 `{`，裸字符串会被拒。
 */
async function exchange(
  alice: Player,
  bob: Player,
  channelId: string,
  count: number,
): Promise<string[]> {
  const contents = Array.from({ length: count }, (_unused, index) => `{"n":${index + 1}}`);
  for (const [index, content] of contents.entries()) {
    const sender = index % 2 === 0 ? alice : bob;
    sender.socket.send(channelMessageSend(`send-${index + 1}`, channelId, content));
    await sender.socket.waitForFrame(
      (frame) =>
        frame.message.case === "channelMessage" && channelMessageOf(frame).content === content,
      ROUND_TRIP_MS,
    );
  }
  return contents;
}

interface Chat {
  readonly channelId: string;
  readonly alice: Player;
  readonly bob: Player;
  readonly contents: readonly string[];
  readonly ids: readonly string[];
}

/** 开一个房间、摆两个客户端、交替发 `count` 条，返回**两边都收到**的那份广播序列。 */
async function startChat(prefix: string, count: number): Promise<Chat> {
  const room = freshRoom(prefix);
  const channelId = roomChannelId(room);
  const alice = await player();
  const bob = await player();

  const aliceJoin = await join(alice.socket, "alice-join", room);
  const bobJoin = await join(bob.socket, "bob-join", room);
  expect(aliceJoin.channelId).toBe(channelId);
  expect(bobJoin.channelId).toBe(channelId);
  // 空房间没有人可看；后进来的人看到的是"已经在房间里的人"（不含刚加入的自己）。
  expect(aliceJoin.presences).toHaveLength(0);
  expect(bobJoin.presences).toHaveLength(1);

  const contents = await exchange(alice, bob, channelId, count);
  const aliceSeen = await waitForMessages(alice, count);
  const bobSeen = await waitForMessages(bob, count);
  // 同一份广播：两个人的 message_id 序列必须逐位相同。
  expect(bobSeen.map((message) => message.messageId)).toEqual(
    aliceSeen.map((message) => message.messageId),
  );
  return { channelId, alice, bob, contents, ids: aliceSeen.map((m) => m.messageId) };
}

async function readHistory(token: string, channelId: string): Promise<HistoryBody> {
  const response = await call(`${channelHistoryPath(channelId)}?limit=100`, { token });
  expect(response.status, `读历史失败：${response.status} ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as HistoryBody;
}

describe("M4 E2E: 频道与聊天", () => {
  it("test_two_clients_exchange_ten_messages_in_one_room_in_the_same_order", { timeout: 180_000 }, async () => {
    const chat = await startChat("e2e-chat", 10);
    const senders = chat.contents.map((_content, index) =>
      index % 2 === 0 ? chat.alice.userId : chat.bob.userId,
    );

    for (const [name, client] of [["alice", chat.alice], ["bob", chat.bob]] as const) {
      const seen = liveMessages(client.socket.frames);
      expect(seen.map((message) => message.content), name).toEqual(chat.contents);
      expect(seen.map((message) => message.messageId), name).toEqual(chat.ids);
      expect(seen.map((message) => message.senderId), name).toEqual(senders);
      expect(seen.map((message) => message.channelId), name).toEqual(
        chat.contents.map(() => chat.channelId),
      );
      // 默认加入就是持久化频道，所以这十条都带 persistent。
      expect(seen.every((message) => message.persistent), name).toBe(true);
    }
  });

  it("test_a_latecomer_joins_the_room_and_reads_the_persisted_history_over_rest", { timeout: 180_000 }, async () => {
    const chat = await startChat("e2e-chat-history", 10);

    // 第三个客户端：它没有参与上面任何一条消息，进来时那两位已经在房间里了。
    const third = await player();
    const thirdJoin = await join(third.socket, "third-join", roomOf(chat.channelId));
    expect(thirdJoin.presences).toHaveLength(2);

    const body = await readHistory(third.token, chat.channelId);
    const messages = body.messages ?? [];
    expect(messages.map((message) => message.content)).toEqual(chat.contents);
    expect(messages.map((message) => message.message_id)).toEqual(chat.ids);
    expect(messages.map((message) => message.sender_id)).toEqual(
      chat.contents.map((_content, index) =>
        index % 2 === 0 ? chat.alice.userId : chat.bob.userId,
      ),
    );
    expect(messages.map((message) => message.username)).toEqual(
      chat.contents.map((_content, index) =>
        index % 2 === 0 ? chat.alice.username : chat.bob.username,
      ),
    );
    expect(messages.map((message) => message.channel_id)).toEqual(
      chat.contents.map(() => chat.channelId),
    );
    // 房间频道带 room_name，不带 group_id / user_id_one。
    expect(messages.map((message) => message.room_name)).toEqual(
      chat.contents.map(() => roomOf(chat.channelId)),
    );
    // 能出现在历史里的消息一定是持久化过的。
    expect(messages.every((message) => message.persistent)).toBe(true);
  });

  it("test_a_non_persistent_room_broadcasts_without_landing_in_history", { timeout: 90_000 }, async () => {
    const room = freshRoom("e2e-chat-volatile");
    const channelId = roomChannelId(room);
    const alice = await player();
    const bob = await player();
    await join(alice.socket, "alice-join", room, { persistence: false });
    await join(bob.socket, "bob-join", room, { persistence: false });

    alice.socket.send(channelMessageSend("volatile-1", channelId, '{"note":"volatile"}'));
    for (const client of [alice, bob]) {
      const frame = await client.socket.waitForFrame(
        (candidate) => candidate.message.case === "channelMessage",
        ROUND_TRIP_MS,
      );
      // 广播照发，且这条自己带着 persistent=false 说出来"我读过就没了"。
      expect(channelMessageOf(frame).persistent).toBe(false);
    }

    // 对面确实收到了，但历史里没有它：REST 回 200、且连 messages 字段都不出现。
    const body = await readHistory(alice.token, channelId);
    expect(body.messages).toBeUndefined();
  });
});
