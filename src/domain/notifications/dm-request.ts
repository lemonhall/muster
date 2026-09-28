/**
 * 私聊请求通知：有人第一次进了你们俩的私聊频道，而你又不在里面。
 *
 * 上游在 `pipeline_channel.go::channelJoin` 里原地拼这条通知（`fmt.Sprintf("%v wants to
 * chat", username)` + `json.Marshal(map[string]string{"username": ...})`）。这里把它搬成
 * 一个纯函数，理由不是"更好看"，而是**它有确定的输入输出、值得被单独断言**：
 * subject 的措辞、content 的形状、code = -1、sender 是谁。
 *
 * 触发条件（"新加入"且"对方不在频道里"）留在频道 DO 里判断——那两件事只有它知道
 * （见 `durable/channel-core.ts` 的 `#dmRequest`）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/core_notification.go::NotificationCodeDmRequest
 *
 * REQ-0001-013
 */

import type { DmRequestNotice } from "../../realtime/channel";
import { NOTIFICATION_CODE } from "./codes";
import type { SendNotificationInput } from "./service";

export function dmRequestNotification(notice: DmRequestNotice): SendNotificationInput {
  return {
    userId: notice.userId,
    subject: `${notice.username} wants to chat`,
    content: JSON.stringify({ username: notice.username }),
    code: NOTIFICATION_CODE.dmRequest,
    senderId: notice.senderId,
  };
}
