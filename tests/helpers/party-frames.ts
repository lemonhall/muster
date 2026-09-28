import { create } from "@bufbuild/protobuf";

import {
  EnvelopeSchema,
  PartyAcceptSchema,
  PartyCloseSchema,
  PartyCreateSchema,
  PartyDataSendSchema,
  PartyJoinRequestListSchema,
  PartyJoinSchema,
  PartyLeaveSchema,
  PartyMatchmakerAddSchema,
  PartyMatchmakerRemoveSchema,
  PartyPromoteSchema,
  PartyRemoveSchema,
  PartyUpdateSchema,
  UserPresenceSchema,
  type Envelope,
  type UserPresence,
} from "../../src/proto/realtime_pb";

/**
 * 派对十二条入站帧的构造器。
 *
 * 走 `create(Schema, ...)` 而不是手拼对象：线格式的字段名、`count_multiple`
 * 那种包装类型的"给没给"，都由生成物决定，测试里再抄一遍只会抄错。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export interface PresenceSpec {
  readonly userId: string;
  readonly sessionId: string;
  readonly username?: string;
}

export function presenceOf(spec: PresenceSpec): UserPresence {
  return create(UserPresenceSchema, {
    userId: spec.userId,
    sessionId: spec.sessionId,
    username: spec.username ?? spec.userId,
  });
}

function frame(cid: string, message: Envelope["message"]): Envelope {
  return create(EnvelopeSchema, { cid, message });
}

export function partyCreateFrame(
  cid: string,
  input: { readonly open?: boolean; readonly hidden?: boolean; readonly maxSize?: number; readonly label?: string } = {},
): Envelope {
  return frame(cid, {
    case: "partyCreate",
    value: create(PartyCreateSchema, {
      open: input.open ?? true,
      hidden: input.hidden ?? false,
      maxSize: input.maxSize ?? 4,
      label: input.label ?? "",
    }),
  });
}

export function partyJoinFrame(cid: string, partyId: string): Envelope {
  return frame(cid, { case: "partyJoin", value: create(PartyJoinSchema, { partyId }) });
}

export function partyLeaveFrame(cid: string, partyId: string): Envelope {
  return frame(cid, { case: "partyLeave", value: create(PartyLeaveSchema, { partyId }) });
}

export function partyPromoteFrame(cid: string, partyId: string, presence: PresenceSpec): Envelope {
  return frame(cid, {
    case: "partyPromote",
    value: create(PartyPromoteSchema, { partyId, presence: presenceOf(presence) }),
  });
}

export function partyAcceptFrame(cid: string, partyId: string, presence: PresenceSpec): Envelope {
  return frame(cid, {
    case: "partyAccept",
    value: create(PartyAcceptSchema, { partyId, presence: presenceOf(presence) }),
  });
}

export function partyRemoveFrame(cid: string, partyId: string, presence: PresenceSpec): Envelope {
  return frame(cid, {
    case: "partyRemove",
    value: create(PartyRemoveSchema, { partyId, presence: presenceOf(presence) }),
  });
}

export function partyCloseFrame(cid: string, partyId: string): Envelope {
  return frame(cid, { case: "partyClose", value: create(PartyCloseSchema, { partyId }) });
}

export function partyJoinRequestListFrame(cid: string, partyId: string): Envelope {
  return frame(cid, {
    case: "partyJoinRequestList",
    value: create(PartyJoinRequestListSchema, { partyId }),
  });
}

export function partyDataSendFrame(
  cid: string,
  partyId: string,
  opCode: bigint,
  data: Uint8Array,
): Envelope {
  return frame(cid, {
    case: "partyDataSend",
    value: create(PartyDataSendSchema, { partyId, opCode, data }),
  });
}

export function partyUpdateFrame(
  cid: string,
  partyId: string,
  input: { readonly label?: string; readonly open?: boolean; readonly hidden?: boolean } = {},
): Envelope {
  return frame(cid, {
    case: "partyUpdate",
    value: create(PartyUpdateSchema, {
      partyId,
      label: input.label ?? "",
      open: input.open ?? true,
      hidden: input.hidden ?? false,
    }),
  });
}

export function partyMatchmakerAddFrame(
  cid: string,
  partyId: string,
  input: {
    readonly minCount?: number;
    readonly maxCount?: number;
    readonly query?: string;
    readonly countMultiple?: number;
    readonly strings?: Readonly<Record<string, string>>;
    readonly numbers?: Readonly<Record<string, number>>;
  } = {},
): Envelope {
  return frame(cid, {
    case: "partyMatchmakerAdd",
    value: create(PartyMatchmakerAddSchema, {
      partyId,
      minCount: input.minCount ?? 2,
      maxCount: input.maxCount ?? 2,
      query: input.query ?? "*",
      stringProperties: { ...(input.strings ?? {}) },
      numericProperties: { ...(input.numbers ?? {}) },
      ...(input.countMultiple === undefined ? {} : { countMultiple: input.countMultiple }),
    }),
  });
}

export function partyMatchmakerRemoveFrame(cid: string, partyId: string, ticket: string): Envelope {
  return frame(cid, {
    case: "partyMatchmakerRemove",
    value: create(PartyMatchmakerRemoveSchema, { partyId, ticket }),
  });
}
