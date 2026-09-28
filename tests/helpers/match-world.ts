import { create } from "@bufbuild/protobuf";
import { env, runInDurableObject } from "cloudflare:test";

import {
  EnvelopeSchema,
  MatchCreateSchema,
  MatchDataSendSchema,
  MatchJoinSchema,
  MatchLeaveSchema,
  MatchmakerAddSchema,
  MatchmakerRemoveSchema,
  UserPresenceSchema,
  type Envelope,
} from "../../src/proto/realtime_pb";
import { matchKeyOf } from "../../src/domain/match/ids";
import { shardKeyOf } from "../../src/realtime/socket-meta";
import { CALLER_ID, CALLER_USERNAME, PEER_ID, PEER_USERNAME, insertUser } from "./realtime";
import { delay, openSocket, sendFrame, waitForFrame, type TestSocket } from "./realtime-socket";
import { authenticateDeviceOrFail, bearer, call, createTenant } from "./tenants";

/**
 * M7 对局/匹配器套件的工装：一个随机租户 + 两个账号 + 若干条**真** WebSocket。
 *
 * 与 `channelWorld` 同一套路：随机租户 = 每个用例一套全新的 DO 存储；
 * 帧走真实编码（`sendFrame`）而不是手拼 JSON，于是"发出去的东西真的是那个帧"
 * 也被覆盖到了。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

/** 第三个账号：离开事件、三方对局这类用例需要"还有一个人"。 */
export const THIRD_ID = "C0000000-0000-4000-8000-000000000003";
export const THIRD_USERNAME = "third";

export function matchmakerAddEnvelope(
  cid: string,
  input: {
    readonly minCount: number;
    readonly maxCount: number;
    readonly query?: string;
    readonly countMultiple?: number;
    readonly strings?: Readonly<Record<string, string>>;
    readonly numbers?: Readonly<Record<string, number>>;
  },
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "matchmakerAdd",
      value: create(MatchmakerAddSchema, {
        minCount: input.minCount,
        maxCount: input.maxCount,
        query: input.query ?? "*",
        stringProperties: { ...(input.strings ?? {}) },
        numericProperties: { ...(input.numbers ?? {}) },
        ...(input.countMultiple === undefined ? {} : { countMultiple: input.countMultiple }),
      }),
    },
  });
}

export function matchmakerRemoveEnvelope(cid: string, ticket: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchmakerRemove", value: create(MatchmakerRemoveSchema, { ticket }) },
  });
}

export function matchCreateEnvelope(cid: string, name = ""): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchCreate", value: create(MatchCreateSchema, { name }) },
  });
}

export function matchJoinEnvelope(
  cid: string,
  target: { readonly matchId?: string; readonly token?: string },
  metadata: Readonly<Record<string, string>> = {},
): Envelope {
  // 三种都造得出来：给 id、给 token、**两个都不给**（上游那条 `No match ID or token found`）。
  const id =
    target.matchId !== undefined
      ? { case: "matchId" as const, value: target.matchId }
      : target.token !== undefined
        ? { case: "token" as const, value: target.token }
        : { case: undefined as undefined, value: undefined };
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchJoin", value: create(MatchJoinSchema, { id, metadata: { ...metadata } }) },
  });
}

export function matchLeaveEnvelope(cid: string, matchId: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchLeave", value: create(MatchLeaveSchema, { matchId }) },
  });
}

export function matchDataSendEnvelope(
  cid: string,
  matchId: string,
  input: {
    readonly opCode: bigint;
    readonly data: Uint8Array;
    readonly reliable?: boolean;
    readonly presences?: readonly { readonly userId: string; readonly sessionId: string }[];
  },
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "matchDataSend",
      value: create(MatchDataSendSchema, {
        matchId,
        opCode: input.opCode,
        data: input.data,
        reliable: input.reliable ?? true,
        presences: (input.presences ?? []).map((presence) =>
          create(UserPresenceSchema, { userId: presence.userId, sessionId: presence.sessionId }),
        ),
      }),
    },
  });
}

export interface MatchWorld {
  readonly tenant: string;
  readonly serverKey: string;
  open(sessionId: string, userId: string, username: string): Promise<TestSocket>;
  /** 开一条 REST 会话（走真实认证端点），拿 bearer 令牌与账号。 */
  restSession(): Promise<{ readonly token: string; readonly userId: string }>;
  matchmaker(): DurableObjectStub;
  match(uuid: string): DurableObjectStub;
  /** 手工跑一轮成局（E2E 之外不去等闹钟）。 */
  process(): Promise<{ readonly matches: number; readonly tickets: readonly string[] }>;
  stats(): Promise<Record<string, unknown>>;
  setHook(hook: unknown): Promise<void>;
  setConfig(config: unknown): Promise<void>;
  closeAll(): Promise<void>;
}

const liveWorlds: MatchWorld[] = [];

export async function matchWorld(): Promise<MatchWorld> {
  const tenant = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenant}`;
  await createTenant(tenant, serverKey, "match");
  for (const [id, username] of [
    [CALLER_ID, CALLER_USERNAME],
    [PEER_ID, PEER_USERNAME],
    [THIRD_ID, THIRD_USERNAME],
  ] as const) {
    await insertUser(tenant, id, username);
  }

  const sessions: TestSocket[] = [];
  const shards = new Map<TestSocket, DurableObjectStub>();
  const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(tenant));

  const world: MatchWorld = {
    tenant,
    serverKey,
    async open(sessionId, userId, username) {
      const socket = await openSocket(tenant, sessionId, userId, username, { wantsStatus: false });
      sessions.push(socket);
      shards.set(
        socket,
        env.SESSION_SHARD.get(env.SESSION_SHARD.idFromName(shardKeyOf(tenant, sessionId))),
      );
      return socket;
    },
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
    matchmaker: () => matchmaker,
    match: (uuid) => env.MATCH.get(env.MATCH.idFromName(matchKeyOf(tenant, uuid))),
    async process() {
      return (await doPost(matchmaker, "/process", {})) as {
        readonly matches: number;
        readonly tickets: readonly string[];
      };
    },
    async stats() {
      return (await doPost(matchmaker, "/stats", {})) as Record<string, unknown>;
    },
    async setHook(hook) {
      await doPost(matchmaker, "/hook", { hook });
    },
    async setConfig(config) {
      await doPost(matchmaker, "/config", { config });
    },
    async closeAll() {
      const opened = sessions.splice(0);
      for (const socket of opened) socket.close();
      await Promise.all(opened.map((socket) => waitForShardDrain(shards.get(socket), socket)));
    },
  };
  liveWorlds.push(world);
  return world;
}

/** 给 DO 发一条 RPC 并解出 JSON；非 2xx 直接抛（测试不该把 500 当成业务失败）。 */
async function doPost(stub: DurableObjectStub, path: string, body: unknown): Promise<unknown> {
  const response = await stub.fetch(`https://do${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`DO ${path} 返回 ${response.status}`);
  return await response.json();
}

/** 与 `channelWorld` 同一条收尾屏障：分片里没有活着的连接才算关干净。 */
async function waitForShardDrain(
  shard: DurableObjectStub | undefined,
  socket: TestSocket,
  timeoutMs = 3000,
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

export async function closeAllMatchWorlds(): Promise<void> {
  const worlds = liveWorlds.splice(0);
  await Promise.all(worlds.map((world) => world.closeAll()));
}

/** 发一帧并等回执（`cid` 相同的那个）。 */
export async function ask(target: TestSocket, envelope: Envelope): Promise<Envelope> {
  sendFrame(target, envelope);
  return await waitForFrame(target, (frame) => frame.cid === envelope.cid);
}
