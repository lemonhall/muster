/**
 * `nk` 的**权威写分**面：`leaderboardRecordWrite` / `leaderboardRecordDelete`。
 *
 * 这一面是 ECN-0010 偏差 10 的另一半。上游的判据只有一句：
 * `LeaderboardRecordWrite(..., uuid.Nil, ...)`——调用者是**平台自己**，而不是某个用户。
 * 于是 `authoritative = 1` 的榜"谁都写不进去"这条客户端可见的差异，在有了这两个能力
 * 之后消失：模块能写，客户端仍然 403（同一条领域函数 `leaderboardRecordWrite`，
 * 只有 `callerId` 不同）。
 *
 * 返回形状是上游 `leaderboardRecordToJsMap`：camelCase，`score` / `subscore` 是
 * **数字**（Go 的 int64 经 goja 出去就是 number），`metadata` 是**对象**，
 * 缺省的 `expiryTime` / `username` 是 `null` 而不是缺字段。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardRecordWrite
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardRecordDelete
 * 契约源: server/runtime_javascript_nakama.go::leaderboardRecordToJsMap
 *
 * REQ-0001-015
 */

import type { DataContext } from "./capability-data";
import { metadataText, optionalInt, optionalText, overrideOperatorOf, ownerIdOf, text } from "./competitive-args";
import { loadLeaderboard } from "../domain/competitive/leaderboard/context";
import type { RankedRecord } from "../domain/competitive/leaderboard/record-store";
import {
  leaderboardRecordDelete,
  leaderboardRecordWrite,
} from "../domain/competitive/leaderboard/write";

function recordToJs(record: RankedRecord): Record<string, unknown> {
  return {
    leaderboardId: record.leaderboard_id,
    ownerId: record.owner_id,
    username: record.username === "" ? null : record.username,
    score: record.score,
    subscore: record.subscore,
    numScore: record.num_score,
    maxNumScore: record.max_num_score,
    metadata: record.metadata === "" ? {} : (JSON.parse(record.metadata) as unknown),
    rank: record.rank,
    createTime: record.create_time,
    updateTime: record.update_time,
    expiryTime: record.expiry_time === 0 ? null : record.expiry_time,
  };
}

export function buildNkRecords(data: DataContext): Record<string, unknown> {
  const db = data.env.DB;
  const tenantId = data.tenantId;

  return {
    leaderboardRecordWrite: async (...args: unknown[]) => {
      const id = text(args[0]);
      if (id === "") throw new TypeError("expects a leaderboard ID string");
      const ownerId = ownerIdOf(args[1]);
      const username = optionalText(args[2]);
      const score = optionalInt(args[3], 0);
      const subscore = optionalInt(args[4], 0);
      const metadata = args[5] === undefined || args[5] === null ? "" : metadataText(args[5]);
      const overrideOperator = overrideOperatorOf(args[6]);

      const leaderboard = await loadLeaderboard(db, tenantId, id);
      if (leaderboard === null) {
        throw new Error("error writing leaderboard record: Leaderboard not found.");
      }
      // `callerId: ""` 就是上游的 `uuid.Nil`：平台自己，权威榜也写得进。
      return recordToJs(
        await leaderboardRecordWrite(
          db,
          tenantId,
          leaderboard,
          { callerId: "", ownerId, username, score, subscore, metadata, overrideOperator },
          new Date(),
        ),
      );
    },

    leaderboardRecordDelete: async (...args: unknown[]) => {
      const id = text(args[0]);
      if (id === "") throw new TypeError("expects a leaderboard ID string");
      const ownerId = ownerIdOf(args[1]);
      const leaderboard = await loadLeaderboard(db, tenantId, id);
      if (leaderboard === null) {
        throw new Error("error deleting leaderboard record: Leaderboard not found.");
      }
      await leaderboardRecordDelete(db, tenantId, leaderboard, "", ownerId, new Date());
    },
  };
}
