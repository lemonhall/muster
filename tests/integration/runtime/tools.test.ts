import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeCache } from "../../../src/runtime/service";
import { deployModules, payloadOf, runtimeWorld, storageRows, walletOf } from "./harness";

/**
 * `nk` 的数据面与工具面（DoD 6/7/8）。
 *
 * 上游那一组 `runtime_test.go` 用例大多只写"调用没报错"（Lua 脚本里连 `assert` 都
 * 不带），本文件的断言一律**读库里的行**：钱包列、`storage_objects`、`notifications`、
 * `groups` / `group_edge`。返回值只用来确定 id 与顺序，不作为"事情发生了"的证据。
 *
 * 每一条 `nk.*` 都是从**隔离区里**发出的（模块注册成 RPC，由 `callTenantRpc` 调进去），
 * 所以这里同时验证了桥本身：宿主闭包里的租户/调用者身份、异步 RPC 的参数编解码、
 * 嵌套对象（`nk.bit32.band`）的 stub 化。
 *
 * 调用约定：handler 的入参是 `(ctx, logger, nk, payload…)`，与上游 `InvokeFunction`
 * 拼的 `[ctx, logger, nk, ...payloads]` 逐位对齐。能力对象必须从参数里拿——宿主为每
 * 一次调用现造它们，在 `InitModule` 时存下的那一份随首次调用的 RPC 会话一起失效。
 *
 * 溯源: server/runtime_test.go::TestRuntimeWalletWrite,TestRuntimeStorageWrite,TestRuntimeStorageRead
 * 溯源: server/runtime_test.go::TestRuntimeNotificationsSend,TestRuntimeNotificationSend,TestRuntimeNotificationsDelete
 * 溯源: server/runtime_test.go::TestRuntimeGroupTests
 */

const GAME_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  // 能力对象一律从 handler 的参数里拿：宿主为每一次调用现造它们，存下来的那一份
  // 在这次调用返回后就随 RPC 会话一起失效（见文件头的调用约定说明）。
  initializer.registerRpc("wallet", async (call, logger, nk) => {
    await nk.walletUpdate(call.userId, { reward_coins: 1000 });
    return "ok";
  });

  initializer.registerRpc("global-write", async (call, logger, nk) => {
    await nk.storageWrite([
      { collection: "settings", key: "a", value: {} },
      { collection: "settings", key: "b", value: {} },
      { collection: "settings", key: "c", value: {} },
    ]);
    return "ok";
  });

  initializer.registerRpc("global-read", async (call, logger, nk) => {
    const rows = await nk.storageRead([
      { collection: "settings", key: "a" },
      { collection: "settings", key: "b" },
      { collection: "settings", key: "c" },
    ]);
    return JSON.stringify(rows.map((row) => Object.keys(row.value).length));
  });

  initializer.registerRpc("notify-many", async (call, logger, nk) => {
    await nk.notificationsSend([
      {
        subject: "You have unlocked level 100!",
        content: { reward_coins: 1000 },
        userId: call.userId,
        code: 1,
      },
    ]);
    return "ok";
  });

  initializer.registerRpc("notify-one", async (call, logger, nk) => {
    await nk.notificationSend(call.userId, "Daily reward", { reward_coins: 5 }, 2);
    return "ok";
  });

  initializer.registerRpc("notify-delete", async (call, logger, nk, notificationId) => {
    await nk.notificationsDelete([{ userId: call.userId, notificationId }]);
    return "ok";
  });

  initializer.registerRpc("group", async (call, logger, nk) => {
    const created = await nk.groupCreate(call.userId, "runtime-group");
    await nk.groupUpdate(created.id, call.userId, "runtime-group-renamed");
    const users = await nk.groupUsersList(created.id);
    const groups = await nk.userGroupsList(call.userId);
    const members = users.groupUsers.map((entry) => ({ id: entry.user.userId, state: entry.state }));
    const listed = groups.userGroups.map((entry) => ({
      name: entry.group.name,
      state: entry.state,
    }));
    await nk.groupDelete(created.id);
    return JSON.stringify({ id: created.id, name: created.name, members, listed });
  });

  initializer.registerRpc("tools", async (call, logger, nk) => {
    const out = {};
    out.md5 = await nk.md5Hash("test");
    out.sha256 = await nk.sha256Hash("test");
    out.base64 = await nk.base64Decode(await nk.base64Encode("hello"));
    out.aes = await nk.aes128Decrypt(
      await nk.aes128Encrypt("abcd", "goldenbridge_key"),
      "goldenbridge_key",
    );
    out.uuidLength = (await nk.uuidv4()).length;
    out.json = await nk.jsonEncode(await nk.jsonDecode('{"key":"value"}'));
    out.band = await nk.bit32.band(12, 10);
    return JSON.stringify(out);
  });
}
`;

interface NotificationRow {
  readonly id: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
}

async function notificationsOf(tenantId: string, userId: string): Promise<NotificationRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, subject, content, code FROM notifications WHERE tenant_id = ?1 AND user_id = ?2 ORDER BY create_time, id",
  )
    .bind(tenantId, userId)
    .all<NotificationRow>();
  return result.results;
}

async function groupNames(tenantId: string, groupId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT name FROM groups WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, groupId)
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function edgeStateOf(tenantId: string, groupId: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT state FROM group_edge WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3",
  )
    .bind(tenantId, groupId, userId)
    .first<{ state: number }>();
  return row?.state ?? -1;
}

/** 每个用例一个随机租户 + 一个部署好的模块，正文只关心那一次调用带来的行。 */
async function world() {
  const created = await runtimeWorld();
  await deployModules(created.tenantId, { game: GAME_MODULE });
  return created;
}

afterEach(() => resetRuntimeCache());

describe("M8 nk 数据面: 钱包", () => {
  it("test_wallet_write_lands_on_the_user_row", async () => {
    const w = await world();
    expect(await payloadOf(w, "wallet")).toBe("ok");
    expect(await walletOf(w.tenantId, w.userId)).toEqual({ reward_coins: 1000 });
  });
});

describe("M8 nk 数据面: 存储", () => {
  it("test_storage_write_persists_three_global_objects", async () => {
    const w = await world();
    expect(await payloadOf(w, "global-write")).toBe("ok");
    const rows = await storageRows(w.tenantId, "settings");
    expect(rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
    // 上游写的是全局对象（`user_id = nil`）：库里用全零 UUID 表示，读写两侧一致。
    expect(rows.every((row) => row.value === "{}")).toBe(true);
  });

  it("test_storage_read_returns_empty_values_for_empty_objects", async () => {
    const w = await world();
    await payloadOf(w, "global-write");
    // 上游断言 `#r.value == 0`：三个对象的值都是空表。
    expect(JSON.parse(await payloadOf(w, "global-read"))).toEqual([0, 0, 0]);
  });
});

describe("M8 nk 数据面: 通知", () => {
  it("test_notifications_send_writes_one_row_per_entry", async () => {
    const w = await world();
    expect(await payloadOf(w, "notify-many")).toBe("ok");
    const rows = await notificationsOf(w.tenantId, w.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("You have unlocked level 100!");
    expect(rows[0]?.code).toBe(1);
    expect(JSON.parse(rows[0]?.content ?? "{}")).toEqual({ reward_coins: 1000 });
  });

  it("test_notification_send_with_positional_arguments", async () => {
    const w = await world();
    expect(await payloadOf(w, "notify-one")).toBe("ok");
    const rows = await notificationsOf(w.tenantId, w.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("Daily reward");
    expect(rows[0]?.code).toBe(2);
  });

  it("test_notifications_delete_removes_the_row", async () => {
    const w = await world();
    await payloadOf(w, "notify-one");
    const before = await notificationsOf(w.tenantId, w.userId);
    expect(before).toHaveLength(1);

    await payloadOf(w, "notify-delete", before[0]?.id ?? "");
    expect(await notificationsOf(w.tenantId, w.userId)).toHaveLength(0);
  });
});

describe("M8 nk 数据面: 群组", () => {
  it("test_group_create_update_list_delete_round_trip", async () => {
    const w = await world();
    const out = JSON.parse(await payloadOf(w, "group")) as {
      id: string;
      name: string;
      members: { id: string; state: number }[];
      listed: { name: string; state: number }[];
    };

    // 建群时 creator 就是 superadmin（state = 0，数值越小权限越大）。
    expect(out.name).toBe("runtime-group");
    expect(out.members).toEqual([{ id: w.userId, state: 0 }]);
    // 改名之后的那个名字在列表里（列表是在 update 之后读的）。
    expect(out.listed).toEqual([{ name: "runtime-group-renamed", state: 0 }]);

    // 删除之后库里没有这个群，也没有它的边。
    expect(await groupNames(w.tenantId, out.id)).toEqual([]);
    expect(await edgeStateOf(w.tenantId, out.id, w.userId)).toBe(-1);
  });
});

describe("M8 nk 工具面: 经隔离区调用", () => {
  it("test_tools_are_reachable_from_a_module_and_match_the_upstream_values", async () => {
    const w = await world();
    const out = JSON.parse(await payloadOf(w, "tools")) as Record<string, unknown>;
    expect(out["md5"]).toBe("098f6bcd4621d373cade4e832627b4f6");
    expect(out["sha256"]).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
    expect(out["base64"]).toBe("hello");
    expect(out["aes"]).toBe("abcd");
    expect(out["uuidLength"]).toBe(36);
    expect(out["json"]).toBe('{"key":"value"}');
    expect(out["band"]).toBe(8);
  });
});
