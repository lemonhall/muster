/**
 * 5 字段 cron 表达式：`分 时 日 月 周`（全部按 **UTC** 解释）。
 *
 * 与上游 `internal/cronexpr` 对齐的三条语义（锦标赛截止时间直接依赖它们）：
 *   1. `next(t)` 返回**严格晚于** t 的下一个命中时刻。上游
 *      `calculateTournamentDeadlines` 用 `Next(t.Add(-1s)) == t` 判断"正好落在重置点"，
 *      这条判断只有在"严格晚于"下才成立；
 *   2. `last(t)` 返回**不晚于** t 的最近一个命中时刻（本项目的选择，见 ECN-0010 偏差 2）；
 *   3. day-of-month 与 day-of-week **同时**受限时是 OR（crontab 手册的行为，
 *      上游 `calculateActualDaysOfMonth` 的注释逐字引用了同一段）。
 *
 * 契约源（机器可读）：
 * 契约源: internal/cronexpr/cronexpr.go::Expression.Next
 * 契约源: internal/cronexpr/cronexpr.go::Expression.Last
 * 契约源: internal/cronexpr/cronexpr.go::Expression.NextN
 * 契约源: internal/cronexpr/cronexpr_next.go::Expression.calculateActualDaysOfMonth
 */

import { FIELD_SPECS, normalizeWeekdays, parseField, type ParsedField } from "./field";

const MINUTE_MS = 60_000;
/** 向前/向后搜索的上限：超过 4 年仍无命中就认为这条表达式永远不会触发。 */
const MAX_SEARCH_DAYS = 366 * 4;

function toMinutes(values: readonly number[], multiplier: number): readonly number[] {
  return values.map((value) => value * multiplier);
}

/** 把 (时, 分) 展开成一天内的分钟偏移，升序。 */
function minutesOfDay(hours: readonly number[], minutes: readonly number[]): readonly number[] {
  const offsets: number[] = [];
  for (const hour of toMinutes(hours, 1)) {
    for (const minute of minutes) offsets.push(hour * 60 + minute);
  }
  return offsets.sort((left, right) => left - right);
}

export class CronExpression {
  readonly source: string;
  readonly #minutes: readonly number[];
  readonly #hours: readonly number[];
  readonly #offsets: readonly number[];
  readonly #months: ParsedField;
  readonly #daysOfMonth: ParsedField;
  readonly #daysOfWeek: ParsedField;
  readonly #weekdays: readonly number[];

  private constructor(
    source: string,
    minutes: ParsedField,
    hours: ParsedField,
    daysOfMonth: ParsedField,
    months: ParsedField,
    daysOfWeek: ParsedField,
  ) {
    this.source = source;
    this.#minutes = minutes.values;
    this.#hours = hours.values;
    this.#offsets = minutesOfDay(this.#hours, this.#minutes);
    this.#months = months;
    this.#daysOfMonth = daysOfMonth;
    this.#daysOfWeek = daysOfWeek;
    this.#weekdays = normalizeWeekdays(daysOfWeek.values);
  }

  /** 解析失败抛错（消息里带字段名），绝不静默降级成 `*`。 */
  static parse(source: string): CronExpression {
    const fields = source.trim().split(/\s+/u);
    if (fields.length !== 5) {
      throw new Error(
        `Invalid cron expression ${JSON.stringify(source)}: expected 5 fields (minute hour day-of-month month day-of-week).`,
      );
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
      string, string, string, string, string,
    ];
    return new CronExpression(
      source.trim(),
      parseField(FIELD_SPECS.minute, minute),
      parseField(FIELD_SPECS.hour, hour),
      parseField(FIELD_SPECS.dayOfMonth, dayOfMonth),
      parseField(FIELD_SPECS.month, month),
      parseField(FIELD_SPECS.dayOfWeek, dayOfWeek),
    );
  }

  /** 这一天的日期部分是否命中（只看日/月/周，不看时分）。 */
  #dayMatches(date: Date): boolean {
    if (!this.#months.values.includes(date.getUTCMonth() + 1)) return false;
    const dayOfMonthHit = this.#daysOfMonth.values.includes(date.getUTCDate());
    const dayOfWeekHit = this.#weekdays.includes(date.getUTCDay());
    const bothRestricted = this.#daysOfMonth.restricted && this.#daysOfWeek.restricted;
    if (bothRestricted) return dayOfMonthHit || dayOfWeekHit;
    if (this.#daysOfMonth.restricted) return dayOfMonthHit;
    if (this.#daysOfWeek.restricted) return dayOfWeekHit;
    return true;
  }

  #dayStart(epochMs: number): number {
    return Math.floor(epochMs / 86_400_000) * 86_400_000;
  }

  /** 严格晚于 `from` 的下一个命中时刻；找不到时抛错（与上游返回零值不同，见 ECN-0010）。 */
  next(from: Date): Date {
    const fromMs = from.getTime();
    const dayStart = this.#dayStart(fromMs);
    // 命中时刻都是整分钟；"严格晚于 from" ⟺ "不早于 from 所在的下一分钟"。
    const firstMinute = Math.floor(fromMs / MINUTE_MS) - Math.floor(dayStart / MINUTE_MS) + 1;
    for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
      const currentStart = dayStart + offset * 86_400_000;
      if (!this.#dayMatches(new Date(currentStart))) continue;
      const lower = offset === 0 ? firstMinute : 0;
      const hit = this.#offsets.find((candidate) => candidate >= lower);
      if (hit !== undefined) return new Date(currentStart + hit * MINUTE_MS);
    }
    throw new Error(`cron expression ${JSON.stringify(this.source)} has no match within 4 years.`);
  }

  /** 不晚于 `from` 的最近一个命中时刻。 */
  last(from: Date): Date {
    const fromMs = from.getTime();
    const dayStart = this.#dayStart(fromMs);
    // "不晚于 from" ⟺ "不晚于 from 所在的那一分钟"。
    const lastMinute = Math.floor(fromMs / MINUTE_MS) - Math.floor(dayStart / MINUTE_MS);
    for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
      const currentStart = dayStart - offset * 86_400_000;
      if (!this.#dayMatches(new Date(currentStart))) continue;
      const upper = offset === 0 ? lastMinute : 1440 - 1;
      let hit: number | undefined;
      for (const candidate of this.#offsets) {
        if (candidate <= upper) hit = candidate;
        else break;
      }
      if (hit !== undefined) return new Date(currentStart + hit * MINUTE_MS);
    }
    throw new Error(`cron expression ${JSON.stringify(this.source)} has no match within 4 years.`);
  }

  /** `from` 之后的 n 个连续命中时刻（升序）。 */
  nextN(from: Date, count: number): Date[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`NextN count must be a positive integer, got ${count}.`);
    }
    const results: Date[] = [];
    let cursor = from;
    for (let index = 0; index < count; index += 1) {
      cursor = this.next(cursor);
      results.push(cursor);
    }
    return results;
  }
}

export function parseCron(source: string): CronExpression {
  return CronExpression.parse(source);
}
