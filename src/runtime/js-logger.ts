/**
 * 隔离区里模块拿到的 `logger`（上游 `server/runtime_javascript_logger.go::NewJsLogger` 的等价物）。
 *
 * 与宿主侧 `runtimeGoLogger` 的两点**刻意不同**（都在上游测试里被钉住）：
 *
 * 1. 隔离区的 logger **不带** `runtime` 字段——上游 `TestJsLoggerWithField` 断言
 *    Context **恰好**是 `[{foo: bar}]`，多一个字段就红；
 * 2. `withField` / `withFields` 返回的是"基础字段 + 新字段"的新对象，**不累积**上一次
 *    派生的结果（上游那次 `withFields` 是在**基础** logger 上叫的）。所以这里每次
 *    派生都从"基础字段"重算，而不是从 `this` 累积。
 *
 * 格式化与宿主侧共用 `formatLog`：`logger.info('%s log', s)` → `"info log"`。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_logger.go::NewJsLogger
 * 契约源: server/runtime_javascript_logger.go::jsLogger.Constructor
 *
 * REQ-0001-020
 */

import { formatLog, type LogLevel, type LogSink } from "./log";

export interface JsLoggerInstance {
  /** 当前实例携带的字段（`logger.withFields({...})` 里那个对象就是它）。 */
  readonly fields: Readonly<Record<string, unknown>>;
  debug(format: string, ...args: readonly unknown[]): void;
  info(format: string, ...args: readonly unknown[]): void;
  warn(format: string, ...args: readonly unknown[]): void;
  error(format: string, ...args: readonly unknown[]): void;
  withField(key: string, value: unknown): JsLoggerInstance;
  withFields(fields: Readonly<Record<string, unknown>>): JsLoggerInstance;
}

/**
 * 上游 `NewJsLogger` 的等价物：`logger` 可以被反复派生，互不污染。
 *
 * 刻意返回**普通对象**（而不是类实例）：这个对象要跨 isolate 边界递进运行时模块，
 * 而 workerd 的 RPC 只对 `RpcTarget`/普通对象里的函数做 stub 化——类实例会被
 * 结构化克隆拒绝（实测 `DataCloneError: Could not serialize object of type "..."`）。
 * 换句话说，这里的形状不是风格选择，是能不能用的前提。
 */
export function createJsLogger(
  sink: LogSink,
  fields: Readonly<Record<string, unknown>> = {},
): JsLoggerInstance {
  const build = (current: Readonly<Record<string, unknown>>): JsLoggerInstance => {
    const emit = (level: LogLevel, format: string, args: readonly unknown[]): void => {
      sink({ level, message: formatLog(format, args), fields: { ...current } });
    };
    return {
      fields: current,
      debug: (format, ...args) => emit("debug", format, args),
      info: (format, ...args) => emit("info", format, args),
      warn: (format, ...args) => emit("warn", format, args),
      error: (format, ...args) => emit("error", format, args),
      // 派生一律从**基础字段**重算（`fields` 作为 base），不累积上一次派生的结果。
      withField: (key, value) => build({ ...fields, [key]: value }),
      withFields: (extra) => build({ ...fields, ...extra }),
    };
  };
  return build({ ...fields });
}
