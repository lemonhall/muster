/**
 * cron 字段解析（**受限子集**，见 ECN-0010 偏差 1）。
 *
 * 上游内嵌的是完整的 `internal/cronexpr`（支持 5/6/7 字段、`L`、`W`、`#`、
 * 秒与年）。本项目只搬运锦标赛/排行榜重置真正用到的那一层能力，并且**显式拒绝**
 * 其余写法——一个"看不懂就当 `*`"的解析器会把运营者写的 `0 9 L * *` 静默变成
 * "每分钟一次"，那是灾难而错误消息只有这一处能拦下。
 *
 * 支持的写法（全部在 5 字段语境下，下文的 `/` 只在"星号加斜杠加步长"里出现）：
 *   星号          任意值
 *   `a`           单值
 *   `a-b`         闭区间
 *   星号加 `/n`   从下界起每 n 个
 *   `a-b/n`       区间内每 n 个
 *   `a,b,c`       逗号列表（元素可以是上面的任意一种）
 *
 * 名字表：月份 `JAN..DEC`、星期 `SUN..SAT`（大小写不敏感），与 crontab 一致。
 */

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

export interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
}

export interface ParsedField {
  /** 命中值的升序去重表；调用方按 `in` 语义使用（`daysOfWeekNormalized` 同理）。 */
  readonly values: readonly number[];
  /** 字段是不是通配（或者等价于通配的写法）。这个标志决定 day-of-month 与 day-of-week 的 OR 规则。 */
  readonly restricted: boolean;
}

export function cronFieldError(spec: FieldSpec, token: string): Error {
  return new Error(`Invalid cron ${spec.name} field: ${token}`);
}

function resolveAtom(spec: FieldSpec, raw: string): number {
  const named = spec.names?.[raw.toUpperCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/u.test(raw)) throw cronFieldError(spec, raw);
  return Number(raw);
}

function clampRange(spec: FieldSpec, value: number, raw: string): number {
  if (value < spec.min || value > spec.max) throw cronFieldError(spec, raw);
  return value;
}

function expandRange(spec: FieldSpec, from: number, to: number, step: number, raw: string): number[] {
  const values: number[] = [];
  if (from > to) throw cronFieldError(spec, raw);
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

function expandTerm(spec: FieldSpec, term: string): number[] {
  const slash = term.indexOf("/");
  const body = slash === -1 ? term : term.slice(0, slash);
  let step = 1;
  if (slash !== -1) {
    const stepText = term.slice(slash + 1);
    if (!/^\d+$/u.test(stepText)) throw cronFieldError(spec, term);
    step = Number(stepText);
    if (step < 1) throw cronFieldError(spec, term);
  }

  if (body === "*" || body === "") {
    // `*/n` 从字段下界起算（与 crontab 一致）。裸 `/n` 不接受。
    if (body === "") throw cronFieldError(spec, term);
    return expandRange(spec, spec.min, spec.max, step, term);
  }

  const dash = body.indexOf("-");
  if (dash !== -1) {
    const from = clampRange(spec, resolveAtom(spec, body.slice(0, dash)), term);
    const to = clampRange(spec, resolveAtom(spec, body.slice(dash + 1)), term);
    return expandRange(spec, from, to, step, term);
  }

  const single = clampRange(spec, resolveAtom(spec, body), term);
  if (slash !== -1) {
    // `a/n` 在 crontab 里没有定义（只有 `*/n` 与 `a-b/n`），拒绝而不是猜。
    throw cronFieldError(spec, term);
  }
  return [single];
}

export function parseField(spec: FieldSpec, text: string): ParsedField {
  if (text === "") throw cronFieldError(spec, text);
  const values = new Set<number>();
  for (const term of text.split(",")) {
    if (term === "") throw cronFieldError(spec, text);
    for (const value of expandTerm(spec, term)) values.add(value);
  }
  if (values.size === 0) throw cronFieldError(spec, text);
  return {
    values: [...values].sort((left, right) => left - right),
    restricted: values.size !== spec.max - spec.min + 1,
  };
}

export const FIELD_SPECS = {
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  dayOfMonth: { name: "day-of-month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  dayOfWeek: { name: "day-of-week", min: 0, max: 7, names: WEEKDAY_NAMES },
} as const satisfies Record<string, FieldSpec>;

/** 星期字段里 7 与 0 都表示周日（crontab 的写法），归一化后只剩 0..6。 */
export function normalizeWeekdays(values: readonly number[]): readonly number[] {
  const set = new Set<number>();
  for (const value of values) set.add(value === 7 ? 0 : value);
  return [...set].sort((left, right) => left - right);
}
