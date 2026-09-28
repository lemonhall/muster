import { describe, expect, it } from "vitest";

import { idsQuery, requestFriend, socialWorld, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * `DELETE /v2/notification`：只删自己的，空 `ids` 是成功的空操作。
 *
 * 三处钉住的行为：
 *   1. `ids` 在 **query** 上（照 swagger），且是 `CollectionFormat: multi`；
 *   2. 删除条件是 `user_id = 我 AND id IN (...)`——别人的 id 传进来是**无声的 0 行**，
 *      既不报错也不删掉别人的通知；
 *   3. 空 `ids` 早退成 200 `{}`（上游 `len(in.GetIds()) == 0`）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_notification.go::DeleteNotifications
 * 契约源: server/core_notification.go::NotificationDelete
 *
 * REQ-0001-013
 */

function deleteNotifications(account: SocialAccount, query = ""): Promise<Response> {
  return call(`/v2/notification${query}`, {
    method: "DELETE",
    authorization: bearer(account.token),
  });
}

describe("DELETE /v2/notification", () => {
  it("deletes the listed notifications of the caller", async () => {
    const world = await socialWorld(3);
    const [first, second, target] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    expect((await requestFriend(first, target)).status).toBe(200);
    expect((await requestFriend(second, target)).status).toBe(200);

    const mine = await world.notifications(target.id);
    expect(mine).toHaveLength(2);
    const [keep, drop] = mine as [typeof mine[number], typeof mine[number]];

    const response = await deleteNotifications(target, `?ids=${encodeURIComponent(drop.id)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    const left = await world.notifications(target.id);
    expect(left.map((row) => row.id)).toEqual([keep.id]);
  });

  it("cannot delete another user's notification and treats an empty list as success", async () => {
    const world = await socialWorld(3);
    const [sender, target, stranger] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    expect((await requestFriend(sender, target)).status).toBe(200);
    const theirs = await world.notifications(target.id);
    const id = theirs[0]?.id ?? "";

    const foreign = await deleteNotifications(stranger, `?${idsQuery([id])}`);
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({});
    // 别人的通知一条不少：`WHERE user_id = ?` 把这次删除变成了 0 行。
    expect(await world.notifications(target.id)).toHaveLength(1);

    const empty = await deleteNotifications(target);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({});
    expect(await world.notifications(target.id)).toHaveLength(1);
  });
});
