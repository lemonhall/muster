import { env, runInDurableObject } from "cloudflare:test";

import { channelKeyOf } from "../../src/durable/channel-call";
import { shardKeyOf } from "../../src/realtime/socket-meta";
import { CALLER_ID, CALLER_USERNAME, PEER_ID, PEER_USERNAME, insertUser } from "./realtime";
import { delay, openSocket, type TestSocket } from "./realtime-socket";
import { authenticateDeviceOrFail, bearer, call, createTenant } from "./tenants";

/**
 * M4 频道套件里"真的把两个租户、三个账号、若干条连接摆好"的那一半工装。
 *
 * 与 M3 的做法一致：每个用例一个**随机租户 id**。频道 DO 的键含租户，所以随机租户
 * 等价于"每个用例一套全新的 DO 存储"，用例之间不会互相看见对方的成员与消息——
 * 这比"跑完清表"可靠得多（DO 的 SQLite 在同一个测试文件里是持久的）。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export interface ChannelWorld {
  /** 主租户：大部分用例都在它里面跑。 */
  readonly tenant: string;
  /** 第二个租户：专门用来验"同名频道互不可见"。 */
  readonly otherTenant: string;
  readonly serverKey: string;
  open(sessionId: string, userId: string, username: string): Promise<TestSocket>;
  /** 开一条 REST 会话（走真实认证端点），返回 bearer 令牌与该账号的 user id。 */
  restSession(): Promise<{ readonly token: string; readonly userId: string }>;
  openIn(
    tenantId: string,
    sessionId: string,
    userId: string,
    username: string,
  ): Promise<TestSocket>;
  channel(tenantId: string, channelId: string): DurableObjectStub;
  closeAll(): Promise<void>;
}

/** 本文件里开过的所有世界；`closeAllWorlds` 在 `afterEach` 里统一收拾。 */
const liveWorlds: ChannelWorld[] = [];

export async function channelWorld(): Promise<ChannelWorld> {
  const tenant = crypto.randomUUID().toUpperCase();
  const otherTenant = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenant}`;
  for (const id of [tenant, otherTenant]) {
    await createTenant(id, `server-key-${id}`, "channel");
    await insertUser(id, CALLER_ID, CALLER_USERNAME);
    await insertUser(id, PEER_ID, PEER_USERNAME);
  }
  const sessions: TestSocket[] = [];
  const shards = new Map<TestSocket, DurableObjectStub>();
  const openIn = async (
    tenantId: string,
    session: string,
    userId: string,
    username: string,
  ): Promise<TestSocket> => {
    // `wantsStatus: false`：这一组测的是频道，状态订阅的噪声越小越好看断言。
    const socket = await openSocket(tenantId, session, userId, username, { wantsStatus: false });
    sessions.push(socket);
    shards.set(socket, env.SESSION_SHARD.get(env.SESSION_SHARD.idFromName(shardKeyOf(tenantId, session))));
    return socket;
  };
  const world: ChannelWorld = {
    tenant,
    otherTenant,
    serverKey,
    open: (session, userId, username) => openIn(tenant, session, userId, username),
    openIn,
    async restSession() {
      const session = await authenticateDeviceOrFail(
        { id: tenant, serverKey },
        `rest-${crypto.randomUUID().slice(0, 8)}`,
      );
      const response = await call("/v2/account", { authorization: bearer(session.token) });
      if (response.status !== 200) throw new Error(`读账号失败：${response.status}`);
      const account = (await response.json()) as { user: { id: string } };
      return { token: session.token, userId: account.user.id };
    },
    channel: (tenantId, channelId) =>
      env.CHANNEL.get(env.CHANNEL.idFromName(channelKeyOf(tenantId, channelId))),
    async closeAll() {
      const opened = sessions.splice(0);
      for (const socket of opened) socket.close();
      // 断开是**异步**到达服务端的：分片的 `#disconnect` 还要发两条跨 DO 调用
      // （注册表 `/disconnect`、每个频道的 `/leaveAll`）。这些调用还在飞的时候测试池
      // 就会拆环境，报一句 `EnvironmentTeardownError: Closing rpc while "resolve" was pending`。
      // 所以这里等一个确定的屏障：分片里已经没有活着的连接。缺陷在收尾阶段才现形，
      // 而收尾阶段没有"再等一个语义条件"的机会，只能在这里等。
      await Promise.all(opened.map((socket) => waitForShardDrain(shards.get(socket), socket)));
    },
  };
  liveWorlds.push(world);
  return world;
}

/** 等分片把这条连接摘干净；超时说明分片没在收尾，是需要查的问题，不是可以忽略的噪声。 */
async function waitForShardDrain(
  shard: DurableObjectStub | undefined,
  socket: TestSocket,
  timeoutMs = 2000,
): Promise<void> {
  if (shard === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const left = await runInDurableObject(shard, (_instance, state) => state.getWebSockets().length);
    if (left === 0) return;
    await delay(10);
  }
  throw new Error(`分片没有在 ${timeoutMs}ms 内摘掉连接：${socket.sessionId}`);
}

/** `afterEach` 用：把本文件里开过的世界全部关掉（失败路径也会走到）。 */
export async function closeAllWorlds(): Promise<void> {
  const worlds = liveWorlds.splice(0);
  await Promise.all(worlds.map((world) => world.closeAll()));
}

/** 会话 id 只要在**同一个分片键**里唯一即可；带前缀是为了失败信息能看懂。 */
export function sessionId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 两个账号 + 两个用户名，写期望值时用常量而不是字面量。 */
export const CALLER = { id: CALLER_ID, username: CALLER_USERNAME } as const;
export const PEER = { id: PEER_ID, username: PEER_USERNAME } as const;

/** 房间频道的 id 形状（`StreamToChannelId`）：`2.<空>.<空>.<房间名>`。 */
export function roomChannelId(room: string): string {
  return `2...${room}`;
}

/** 私聊频道的 id 形状：`4.<uid_one>.<uid_two>.`（两个 uid 按字符串序）。 */
export function directChannelId(one: string, two: string): string {
  const [first, second] = one > two ? [two, one] : [one, two];
  return `4.${first}.${second}.`;
}

/** 频道历史的 REST 路径（id 里有点，但点不是保留字符，照样编码一下求稳）。 */
export function channelHistoryPath(channelId: string, query = ""): string {
  return `/v2/channel/${encodeURIComponent(channelId)}${query}`;
}

/** 用指定令牌读频道历史。 */
export function listChannelHistoryAs(
  token: string,
  channelId: string,
  query = "",
): Promise<Response> {
  return call(channelHistoryPath(channelId, query), { authorization: bearer(token) });
}

/** 开一条**新的** REST 会话去读频道历史：这正是"第三个客户端读历史"的视角。 */
export async function listChannelHistory(
  world: ChannelWorld,
  channelId: string,
  query = "",
): Promise<Response> {
  const rest = await world.restSession();
  return listChannelHistoryAs(rest.token, channelId, query);
}
