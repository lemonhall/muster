import { describe, expect, it } from "vitest";

import { formatLog, runtimeGoLogger, type LogRecord } from "../../../src/runtime/log";

/**
 * 宿主侧结构化日志的契约测试。
 *
 * 逐条搬运 `server/runtime_go_logger_test.go`：等级分流、`%s` 格式化、
 * `runtime = "go"` 恒在、`withField(s)` 派生新 logger、`Fields()` 不露 `runtime`。
 *
 * 溯源: server/runtime_go_logger_test.go::TestGoLoggerInfo,TestGoLoggerWarn,TestGoLoggerError,TestGoLoggerDebug,TestGoLoggerWithField,TestGoLoggerWithFields,TestGoLoggerFields
 */

function collector(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

describe("M8 宿主日志: Levels", () => {
  it("test_info_carries_the_go_runtime_field", () => {
    const { records, sink } = collector();
    runtimeGoLogger(sink).info("%s log", "info");

    expect(records.length).toBe(1);
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.message).toBe("info log");
    expect(records[0]?.fields["runtime"]).toBe("go");
  });

  it("test_warn_carries_the_go_runtime_field", () => {
    const { records, sink } = collector();
    runtimeGoLogger(sink).warn("%s log", "warn");

    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.message).toBe("warn log");
    expect(records[0]?.fields["runtime"]).toBe("go");
  });

  it("test_error_carries_the_go_runtime_field", () => {
    const { records, sink } = collector();
    runtimeGoLogger(sink).error("%s log", "error");

    expect(records[0]?.level).toBe("error");
    expect(records[0]?.message).toBe("error log");
    expect(records[0]?.fields["runtime"]).toBe("go");
  });

  it("test_debug_carries_the_go_runtime_field", () => {
    const { records, sink } = collector();
    runtimeGoLogger(sink).debug("%s log", "debug");

    expect(records[0]?.level).toBe("debug");
    expect(records[0]?.message).toBe("debug log");
    expect(records[0]?.fields["runtime"]).toBe("go");
  });
});

describe("M8 宿主日志: 字段派生", () => {
  it("test_with_field_adds_one_field_and_keeps_runtime", () => {
    const { records, sink } = collector();
    runtimeGoLogger(sink).withField("key", "value").info("log with field");

    expect(records.length).toBe(1);
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.fields["runtime"]).toBe("go");
    expect(records[0]?.fields["key"]).toBe("value");
  });

  it("test_with_fields_cannot_overwrite_runtime", () => {
    const { records, sink } = collector();
    runtimeGoLogger(sink)
      .withFields({ key1: "value1", key2: 2, runtime: "foo" })
      .info("log message");

    expect(records.length).toBe(1);
    expect(records[0]?.message).toBe("log message");
    expect(records[0]?.fields["runtime"]).toBe("go");
    expect(records[0]?.fields["key1"]).toBe("value1");
    expect(records[0]?.fields["key2"]).toBe(2);
  });

  it("test_fields_hides_runtime_and_survives_chaining", () => {
    const { sink } = collector();
    const logger1 = runtimeGoLogger(sink).withField("key1", "value1");

    expect(logger1.fields()["key1"]).toBe("value1");
    expect("runtime" in logger1.fields()).toBe(false);

    const logger2 = logger1.withFields({ key2: "value2", key3: 3, runtime: "foo" });
    expect(logger2.fields()["key1"]).toBe("value1");
    expect(logger2.fields()["key2"]).toBe("value2");
    expect(logger2.fields()["key3"]).toBe(3);
    expect("runtime" in logger2.fields()).toBe(false);
    // 派生不改原来的那一份。
    expect("key2" in logger1.fields()).toBe(false);
  });
});

describe("M8 宿主日志: 格式化", () => {
  it("test_percent_s_placeholders_are_replaced_in_order", () => {
    expect(formatLog("%s and %s", ["a", "b"])).toBe("a and b");
  });

  it("test_extra_arguments_are_appended", () => {
    expect(formatLog("only", ["extra"])).toBe("only extra");
  });

  it("test_missing_arguments_leave_the_placeholder_alone", () => {
    expect(formatLog("%s and %s", ["a"])).toBe("a and %s");
  });
});
