import { describe, expect, it } from "vitest";

import { createJsLogger } from "../../../src/runtime/js-logger";
import type { LogRecord } from "../../../src/runtime/log";

/**
 * 隔离区 `logger` 的契约测试。
 *
 * 逐条搬运 `server/runtime_javascript_logger_test.go`：等级、`%s` 格式化、
 * `withField` / `withFields` 的**字段集合恰好相等**（多一个 `runtime` 都会红）。
 *
 * 溯源: server/runtime_javascript_logger_test.go::TestJsLoggerInfo,TestJsLoggerWarn,TestJsLoggerError,TestJsLoggerDebug,TestJsLoggerWithField,TestJsLoggerWithFields
 */

function collector(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

describe("M8 隔离区日志: Levels", () => {
  it("test_info_formats_the_message", () => {
    const { records, sink } = collector();
    createJsLogger(sink).info("%s log", "info");

    expect(records.length).toBe(1);
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.message).toBe("info log");
  });

  it("test_warn_formats_the_message", () => {
    const { records, sink } = collector();
    createJsLogger(sink).warn("%s log", "warn");

    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.message).toBe("warn log");
  });

  it("test_error_formats_the_message", () => {
    const { records, sink } = collector();
    createJsLogger(sink).error("%s log", "error");

    expect(records[0]?.level).toBe("error");
    expect(records[0]?.message).toBe("error log");
  });

  it("test_debug_formats_the_message", () => {
    const { records, sink } = collector();
    createJsLogger(sink).debug("%s log", "debug");

    expect(records[0]?.level).toBe("debug");
    expect(records[0]?.message).toBe("debug log");
  });
});

describe("M8 隔离区日志: 字段", () => {
  it("test_with_field_context_is_exactly_the_one_field", () => {
    const { records, sink } = collector();
    createJsLogger(sink).withField("foo", "bar").info("some log");

    expect(records.length).toBe(1);
    expect(records[0]?.message).toBe("some log");
    expect(records[0]?.fields).toEqual({ foo: "bar" });
  });

  it("test_with_fields_does_not_accumulate_derived_fields", () => {
    const { records, sink } = collector();
    const logger = createJsLogger(sink);

    const first = logger.withField("logger", "l1");
    const second = logger.withFields({ logger: "l2", n: 1 });
    first.info("logger one");
    second.info("logger two");

    expect(records.length).toBe(2);
    expect(records[0]?.message).toBe("logger one");
    expect(records[0]?.fields).toEqual({ logger: "l1" });
    expect(records[1]?.message).toBe("logger two");
    expect(records[1]?.fields).toEqual({ logger: "l2", n: 1 });
  });

  it("test_base_fields_are_preserved_when_deriving", () => {
    const { records, sink } = collector();
    createJsLogger(sink, { request: "r-1" }).withField("foo", "bar").info("hello");

    expect(records[0]?.fields).toEqual({ request: "r-1", foo: "bar" });
  });
});
