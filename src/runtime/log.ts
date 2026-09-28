/**
 * 宿主侧的结构化日志（上游 `server/runtime_go_logger.go` 的等价物）。
 *
 * 逐条对齐 `TestGoLogger*` 钉住的四件事：
 *
 * 1. 每条记录都带一个**恒在**的字段 `runtime = "go"`——它标明"这条日志来自宿主侧
 *    的 Go 运行时"，与隔离区里模块自己的 `logger`（`runtime = "js"`？不，见下）
 *    区分开。上游这里写死字符串 `"go"`；
 * 2. `withField` / `withFields` 返回**新** logger，不改原来的（zap 的语义，也是
 *    "错误是一等公民"之外最容易踩的一条：改原对象会让并发调用互相染色）；
 * 3. 模块作者试图用 `withFields({runtime: "foo"})` 覆盖它**无效**——`runtime` 字段
 *    由本层最后落定；
 * 4. `Fields()` 只返回用户字段，**不含** `runtime`。
 *
 * 格式化是 zap SugaredLogger 的形状：`logger.info("%s log", "info")` → `"info log"`。
 * 占位符比参数多时保留原样的占位符（Go 的 `%!s(MISSING)` 我们不模仿，那属于
 * 上游的失误细节，模块作者不该依赖）；参数比占位符多时按空格追加。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_go_logger.go::NewRuntimeGoLogger
 * 契约源: server/runtime_go_logger.go::RuntimeGoLogger.WithField
 * 契约源: server/runtime_go_logger.go::RuntimeGoLogger.WithFields
 * 契约源: server/runtime_go_logger.go::RuntimeGoLogger.Fields
 *
 * REQ-0001-020
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type LogSink = (record: LogRecord) => void;

export interface RuntimeLogger {
  debug(format: string, ...args: readonly unknown[]): void;
  info(format: string, ...args: readonly unknown[]): void;
  warn(format: string, ...args: readonly unknown[]): void;
  error(format: string, ...args: readonly unknown[]): void;
  withField(key: string, value: unknown): RuntimeLogger;
  withFields(fields: Readonly<Record<string, unknown>>): RuntimeLogger;
  /** 用户字段（**不含** `runtime`）。 */
  fields(): Record<string, unknown>;
}

/** `runtime` 是保留字段名：模块作者写不进去，本层最后落定。 */
const RUNTIME_FIELD = "runtime";
const RUNTIME_VALUE = "go";

/** 默认打到控制台：本地 `wrangler dev` 与线上 Workers Logs 都能看到。 */
export const consoleSink: LogSink = (record) => {
  const line = { ...record.fields, message: record.message };
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
};

/**
 * zap SugaredLogger 风格的 `%s` / `%d` / `%v` / `%j` 替换。
 *
 * 只做"按顺序吃掉参数"这一件事：多余参数按空格追加（与 `fmt.Sprint` 的尾巴一致）。
 */
export function formatLog(format: string, args: readonly unknown[]): string {
  let index = 0;
  const rendered = format.replace(/%[sdvjfq%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= args.length) return token;
    const value = args[index];
    index += 1;
    if (token === "%j" || token === "%v") {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  });
  const rest = args.slice(index);
  return rest.length === 0 ? rendered : `${rendered} ${rest.map((value) => String(value)).join(" ")}`;
}

class GoLogger implements RuntimeLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly userFields: Readonly<Record<string, unknown>>,
  ) {}

  private emit(level: LogLevel, format: string, args: readonly unknown[]): void {
    this.sink({
      level,
      message: formatLog(format, args),
      fields: { ...this.userFields, [RUNTIME_FIELD]: RUNTIME_VALUE },
    });
  }

  debug(format: string, ...args: readonly unknown[]): void {
    this.emit("debug", format, args);
  }

  info(format: string, ...args: readonly unknown[]): void {
    this.emit("info", format, args);
  }

  warn(format: string, ...args: readonly unknown[]): void {
    this.emit("warn", format, args);
  }

  error(format: string, ...args: readonly unknown[]): void {
    this.emit("error", format, args);
  }

  withField(key: string, value: unknown): RuntimeLogger {
    return this.withFields({ [key]: value });
  }

  withFields(fields: Readonly<Record<string, unknown>>): RuntimeLogger {
    const merged: Record<string, unknown> = { ...this.userFields };
    for (const [key, value] of Object.entries(fields)) {
      if (key === RUNTIME_FIELD) continue; // 覆盖 runtime 无效
      merged[key] = value;
    }
    return new GoLogger(this.sink, merged);
  }

  fields(): Record<string, unknown> {
    return { ...this.userFields };
  }
}

/** 上游 `NewRuntimeGoLogger` 的等价物：给一个 sink，得到一条可派生的 logger。 */
export function runtimeGoLogger(sink: LogSink = consoleSink): RuntimeLogger {
  return new GoLogger(sink, {});
}
