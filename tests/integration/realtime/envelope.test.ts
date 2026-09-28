import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  ChannelJoinSchema,
  ChannelJoin_Type,
  EnvelopeSchema,
  ErrorSchema,
  PingSchema,
  PongSchema,
  StatusSchema,
  StatusUpdateSchema,
} from "../../../src/proto/realtime_pb";
import { decodeEnvelope, encodeEnvelope } from "../../../src/realtime/envelope";

/**
 * M3 契约测试：`Envelope` 的二进制编解码。
 *
 * 编解码器**不是手写的**：它由上游 `realtime.proto` 经 buf + protoc-gen-es 生成
 * （`npm run proto:gen`），这里断言的是我们这层薄封装真的能用它、且线格式与上游一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 *
 * REQ-0001-008
 */

describe("M3 契约: Envelope 二进制编解码", () => {
  it("test_envelope_round_trips_with_cid_preserved", () => {
    const outbound = create(EnvelopeSchema, {
      cid: "cid-1",
      message: { case: "ping", value: create(PingSchema, {}) },
    });

    const decoded = decodeEnvelope(encodeEnvelope(outbound, "protobuf"), "protobuf");

    expect(decoded.cid).toBe("cid-1");
    expect(decoded.message.case).toBe("ping");
  });

  it("test_ping_envelope_bytes_match_a_frozen_golden_vector", () => {
    const bytes = encodeEnvelope(
      create(EnvelopeSchema, {
        cid: "cid-1",
        message: { case: "ping", value: create(PingSchema, {}) },
      }),
      "protobuf",
    );

    // 冻结的黄金向量，来源见文件末尾："由 protobufjs 的反射编码器独立算出"。
    expect(toHex(bytes)).toBe("0a 05 63 69 64 2d 31 82 02 00");
  });

  it("test_json_format_matches_the_protojson_shape", () => {
    const bytes = encodeEnvelope(
      create(EnvelopeSchema, {
        cid: "cid-2",
        message: { case: "pong", value: create(PongSchema, {}) },
      }),
      "json",
    );

    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ cid: "cid-2", pong: {} });
  });

  it("test_malformed_bytes_are_rejected_instead_of_silently_decoded", () => {
    // 截断的帧必须抛错，不允许被当成"空消息"悄悄放过。
    expect(() => decodeEnvelope(new Uint8Array([0x0a, 0x05, 0x63]), "protobuf")).toThrow();
  });

  it("test_empty_envelope_encodes_to_zero_bytes", () => {
    // proto3 的默认值不上线：一个什么都没设的 Envelope 就是空字节。
    expect(encodeEnvelope(create(EnvelopeSchema, {}), "protobuf")).toHaveLength(0);
  });

  it("test_every_oneof_case_survives_a_binary_round_trip", () => {
    const messageOneof = EnvelopeSchema.oneofs.find((oneof) => oneof.localName === "message");
    const fields = messageOneof?.fields ?? [];
    // 上游 realtime.proto 的 Envelope 共 51 个字段：`cid` + 50 个 oneof 消息类型。
    // 这里断言的是 oneof 本身，所以是 50；少于这个数说明 proto 或生成物残缺。
    expect(fields).toHaveLength(50);
    expect(fields.map((field) => field.number)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 2),
    );

    for (const field of fields) {
      if (field.message === undefined) continue;
      const envelope = create(EnvelopeSchema, {
        cid: field.name,
        message: { case: field.localName, value: create(field.message) } as never,
      });

      const decoded = decodeEnvelope(encodeEnvelope(envelope, "protobuf"), "protobuf");

      expect(decoded.cid).toBe(field.name);
      expect(decoded.message.case).toBe(field.localName);
    }
  });

  it("test_generated_codec_agrees_with_an_independent_encoder", () => {
    // 三条黄金向量，覆盖：字符串字段、二级嵌套消息、>15 的一字节以上的 tag、
    // google.protobuf 包装类型、枚举、以及"没有 cid"的错误帧。
    // 它们由 protobufjs（与 protoc-gen-es 完全不相干的一套实现）编码后冻结，
    // 与本项目生成物逐字节比对——这就是"字节级互通"的证据形态。
    expect(
      toHex(
        encodeEnvelope(
          create(EnvelopeSchema, {
            cid: "c2",
            message: {
              case: "statusUpdate",
              value: create(StatusUpdateSchema, { status: "in game" }),
            },
          }),
          "protobuf",
        ),
      ),
    ).toBe("0a 02 63 32 ea 01 0b 0a 09 0a 07 69 6e 20 67 61 6d 65");

    expect(
      toHex(
        encodeEnvelope(
          create(EnvelopeSchema, {
            cid: "c3",
            message: {
              case: "channelJoin",
              value: create(ChannelJoinSchema, {
                target: "room-1",
                type: ChannelJoin_Type.ROOM,
                persistence: true,
                hidden: false,
              }),
            },
          }),
          "protobuf",
        ),
      ),
    ).toBe("0a 02 63 33 1a 10 0a 06 72 6f 6f 6d 2d 31 10 01 1a 02 08 01 22 00");

    expect(
      toHex(
        encodeEnvelope(
          create(EnvelopeSchema, {
            message: {
              case: "error",
              value: create(ErrorSchema, { code: 3, message: "Invalid user identifier" }),
            },
          }),
          "protobuf",
        ),
      ),
    ).toBe("5a 1b 08 03 12 17 49 6e 76 61 6c 69 64 20 75 73 65 72 20 69 64 65 6e 74 69 66 69 65 72");
  });

  it("test_status_envelope_round_trips_with_presences", () => {
    const envelope = create(EnvelopeSchema, {
      cid: "follow-1",
      message: {
        case: "status",
        value: create(StatusSchema, {
          presences: [
            {
              userId: "user-1",
              sessionId: "session-1",
              username: "player1",
              status: "idle",
            },
          ],
        }),
      },
    });

    const decoded = decodeEnvelope(encodeEnvelope(envelope, "protobuf"), "protobuf");
    expect(decoded.message.case).toBe("status");
    const status = decoded.message.value as unknown as { presences: { username: string }[] };
    expect(status.presences.map((presence) => presence.username)).toEqual(["player1"]);
  });
});

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
