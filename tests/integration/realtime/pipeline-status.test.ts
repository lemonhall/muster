import { describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import { handleEnvelope } from "../../../src/realtime/pipeline";
import {
  ABSENT_ID,
  CALLER_ID,
  CALLER_USERNAME,
  PEER_ID,
  PEER_USERNAME,
  errorOf,
  insertUser,
  onlyReply,
  pipelineContext,
  presenceKeys,
  recordingStatus,
  sole,
  statusFollowEnvelope,
  statusUnfollowEnvelope,
  statusUpdateEnvelope,
} from "../../helpers/realtime";
import { createBothTenants, TENANT_A } from "../../helpers/tenants";

/**
 * M3 契约测试：`status_follow` / `status_unfollow` / `status_update` 的语义。
 *
 * 期望值来自上游 `server/pipeline_status.go`，其中有三条容易被"顺手优化掉"的规则，
 * 这里逐条钉住：
 *
 * 1. **只订阅查得到的账号**：查不到的 id/username 既不报错也不订阅；
 * 2. **不能关注自己**：自述 id 被静默跳过，跳过之后若什么都不剩，回的就是空快照；
 * 3. **长度上限是字节**：上游写的是 `len(Status.Value) > 2048`，Go 的 `len` 数字节，
 *    所以 683 个汉字就已经超限（错误消息里说"characters"，行为上是 bytes）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_status.go::Pipeline.statusFollow
 * 契约源: server/pipeline_status.go::Pipeline.statusUnfollow
 * 契约源: server/pipeline_status.go::Pipeline.statusUpdate
 *
 * REQ-0001-009
 */

/** 每个用例先把两个租户与两个真账号摆好；注册表是假的，只用来看"说了什么"。 */
async function seedUsers(): Promise<void> {
  await createBothTenants();
  await insertUser(TENANT_A, CALLER_ID, CALLER_USERNAME);
  await insertUser(TENANT_A, PEER_ID, PEER_USERNAME);
}

describe("M3 契约: status_follow / status_unfollow", () => {
  it("test_status_follow_with_no_input_returns_an_empty_snapshot", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-empty"),
    );

    expect(result.close).toBe(false);
    expect(presenceKeys(onlyReply(result))).toEqual([]);
    expect(status.follows).toHaveLength(0);
  });

  it("test_status_follow_ignores_users_that_do_not_exist", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-absent", { userIds: [ABSENT_ID] }),
    );

    expect(presenceKeys(onlyReply(result))).toEqual([]);
    expect(result.close).toBe(false);
    // 查不到就不订阅：订阅一个不存在的账号，只会让"以后他上线"永远不会发生。
    expect(status.follows).toEqual([{ sessionId: "session-under-test", userIds: [] }]);
  });

  it("test_status_follow_never_subscribes_the_session_to_itself", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-self", { userIds: [CALLER_ID], usernames: [CALLER_USERNAME] }),
    );

    expect(presenceKeys(onlyReply(result))).toEqual([]);
    // 跳过自己之后什么都不剩 → 上游直接回空快照，连注册表都不用打扰。
    // （注意这不等于"会话不关注自己"：握手时的自我关注是注册表那侧的另一条路径。）
    expect(status.follows).toHaveLength(0);
  });

  it("test_status_follow_resolves_usernames_and_other_spellings_to_user_ids", async () => {
    await seedUsers();
    const status = recordingStatus();

    // 同一个人用三种写法出现：用户名、小写带连字符、32 位无连字符。
    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-peer", {
        userIds: [PEER_ID.toLowerCase(), PEER_ID.replace(/-/g, "")],
        usernames: [PEER_USERNAME],
      }),
    );

    expect(result.close).toBe(false);
    // 去重后只剩一个 id，而且是本项目 `users.id` 的大写标准形。
    expect(status.follows).toEqual([{ sessionId: "session-under-test", userIds: [PEER_ID] }]);
  });

  it("test_status_follow_returns_the_presence_snapshot_from_the_registry", async () => {
    await seedUsers();
    const status = recordingStatus([
      { userId: PEER_ID, sessionId: "peer-session", username: PEER_USERNAME, status: "idle" },
    ]);

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-live", { userIds: [PEER_ID] }),
    );

    expect(result.close).toBe(false);
    expect(presenceKeys(onlyReply(result))).toEqual([`${PEER_ID}/peer-session/idle`]);
    expect(onlyReply(result).cid).toBe("c-live");
  });

  it("test_status_unfollow_with_no_user_ids_never_touches_the_registry", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUnfollowEnvelope("c-none", []),
    );

    expect(result.close).toBe(false);
    expect(onlyReply(result).message.case).toBeUndefined();
    expect(onlyReply(result).cid).toBe("c-none");
    expect(status.unfollows).toHaveLength(0);
  });

  it("test_status_unfollow_drops_the_requested_users_and_acknowledges_quietly", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUnfollowEnvelope("c-drop", [PEER_ID, CALLER_ID]),
    );

    // 自己那条被跳过（本来也没关注自己），回执是"只有 cid 的空信封"。
    expect(status.unfollows).toEqual([{ sessionId: "session-under-test", userIds: [PEER_ID] }]);
    expect(onlyReply(result).message.case).toBeUndefined();
    expect(result.close).toBe(false);
  });

  it("test_status_unfollow_rejects_a_malformed_user_identifier", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUnfollowEnvelope("c-bad", ["nope"]),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid user identifier",
    });
    expect(result.close).toBe(true);
    expect(status.unfollows).toHaveLength(0);
  });
});

describe("M3 契约: status_update", () => {
  it("test_status_update_publishes_the_status_text_and_acknowledges", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUpdateEnvelope("c-set", "in game"),
    );

    expect(status.publishes).toEqual([
      {
        sessionId: "session-under-test",
        userId: CALLER_ID,
        username: CALLER_USERNAME,
        status: "in game",
      },
    ]);
    expect(onlyReply(result).message.case).toBeUndefined();
    expect(result.close).toBe(false);
  });

  it("test_status_update_without_a_status_means_going_offline", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUpdateEnvelope("c-offline"),
    );

    expect(status.publishes).toEqual([
      {
        sessionId: "session-under-test",
        userId: CALLER_ID,
        username: CALLER_USERNAME,
        status: null,
      },
    ]);
    expect(onlyReply(result).message.case).toBeUndefined();
    expect(result.close).toBe(false);
  });

  it("test_status_update_accepts_exactly_2048_bytes", async () => {
    await seedUsers();
    const status = recordingStatus();
    const text = "a".repeat(2048);

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUpdateEnvelope("c-limit", text),
    );

    expect(sole(status.publishes, "发布").status).toBe(text);
    expect(result.close).toBe(false);
  });

  it("test_status_update_rejects_text_over_2048_bytes", async () => {
    await seedUsers();
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUpdateEnvelope("c-over", "a".repeat(2049)),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Status must be 2048 characters or less",
    });
    expect(result.close).toBe(true);
    expect(status.publishes).toHaveLength(0);
  });

  it("test_status_update_counts_bytes_rather_than_characters", async () => {
    await seedUsers();
    const status = recordingStatus();
    // 683 个汉字 = 2049 字节：字符数远没到 2048，但上游算的是字节。
    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusUpdateEnvelope("c-cjk", "汉".repeat(683)),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Status must be 2048 characters or less",
    });
    expect(result.close).toBe(true);
  });
});
