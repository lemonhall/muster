/**
 * 用户 id 的解析与规范化。
 *
 * 上游 `pipeline_status.go` 用 `uuid.FromString(uid)` 校验客户端送来的 id
 * （gofrs/uuid 接受多种写法：带连字符的标准形、32 位无连字符、`urn:uuid:` 前缀、
 * 花括号包裹）。解析失败就是 `BAD_INPUT "Invalid user identifier"`。
 *
 * 一点实现差异：gofrs 的 `UUID.String()` 输出**小写**，而本项目的 `users.id`
 * 统一存**大写**（见身份域）。所以这里解析成功后再规范成大写标准形再查库，
 * 让"大写写入、任意写法查询"两种习惯都能对上，而不是把大小写敏感性留给调用方去猜。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_status.go::Pipeline.statusFollow
 */

const HEX = /^[0-9a-fA-F]+$/;

/**
 * 解析成 32 位十六进制（不带连字符）的规范形；不是合法 UUID 时返回 null。
 * 这里不校验版本/变体位——上游也不校验，`uuid.FromString` 只认形状。
 */
function toCanonicalHex(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("urn:uuid:")) value = value.slice("urn:uuid:".length);
  if (value.length === 38 && value.startsWith("{") && value.endsWith("}")) {
    value = value.slice(1, -1);
  }

  const hex = value.replace(/-/g, "");
  if (hex.length !== 32 || !HEX.test(hex)) return null;
  // 有连字符时必须是 8-4-4-4-12 的形状，否则 `1-2-3-...` 这种会被误判。
  if (value.includes("-") && !/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value)) {
    return null;
  }
  return hex.toUpperCase();
}

/** 客户端送来的 id → 本项目 `users.id` 的写法（大写、带连字符）；非法返回 null。 */
export function normalizeUserId(raw: string): string | null {
  const hex = toCanonicalHex(raw);
  if (hex === null) return null;
  return formatHex(hex, true);
}

/**
 * 消息 id 的规范化：与 `normalizeUserId` 同一套解析规则，但输出**小写**标准形。
 *
 * 为什么两条 id 的大小写不同：用户 id 是本项目自己铸的（身份域统一大写），而消息 id
 * 在线上是上游 `uuid.Must(uuid.NewV4()).String()` 的小写写法，客户端可能把它原样存下来
 * 再回传。上游用 Postgres 的 `uuid` 类型比较（天然不区分大小写），我们用文本比较，
 * 所以**在入口处统一大小写**才是等价实现——否则客户端把 id 写成大写就"查不到这条消息"。
 */
export function normalizeMessageId(raw: string): string | null {
  const hex = toCanonicalHex(raw);
  if (hex === null) return null;
  return formatHex(hex, false);
}

function formatHex(hex: string, upper: boolean): string {
  const digits = upper ? hex : hex.toLowerCase();
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    digits.slice(12, 16),
    digits.slice(16, 20),
    digits.slice(20),
  ].join("-");
}
