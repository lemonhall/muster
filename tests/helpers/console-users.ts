import { ApiError } from "../../src/http/errors";
import {
  SerializationFailure,
  type ConsoleAuditEntry,
  type ConsoleUserRecord,
  type ConsoleUserStore,
  type NewConsoleUser,
  type PasswordPatch,
} from "../../src/domain/console/users/service";

/**
 * 控制台用户用例层的**假端口**。
 *
 * 它存在的理由就是 DoD 3/5 的反作弊要求"用计数证明副作用没发生"：
 * 真 D1 里"没写一行"与"写了又删了"从外部看不出区别，而这个假端口把
 * `inserts` / `writes` / `audits` / `reads` 四个计数直接摊开给断言。
 *
 * 文件名不带 `.test.ts`，所以不会被 vitest 收集成测试文件。
 */

export interface FakeConsoleStore extends ConsoleUserStore {
  readonly state: {
    /** 目标用户的 ACL JSON；`null` 表示"这个用户不存在"。 */
    targetAcl: string | null;
    /** 还欠几次读失败（模拟 D1 写冲突）。 */
    readFailures: number;
    reads: number;
    /** 密码写回次数——DoD 5 的拒绝格必须为 0。 */
    writes: number;
    inserts: number;
    audits: number;
    readonly inserted: NewConsoleUser[];
    readonly patches: PasswordPatch[];
    readonly auditEntries: ConsoleAuditEntry[];
  };
}

export function fakeConsoleUserStore(
  options: { readonly targetAcl?: string | null; readonly readFailures?: number } = {},
): FakeConsoleStore {
  const state: FakeConsoleStore["state"] = {
    targetAcl: options.targetAcl ?? null,
    readFailures: options.readFailures ?? 0,
    reads: 0,
    writes: 0,
    inserts: 0,
    audits: 0,
    inserted: [],
    patches: [],
    auditEntries: [],
  };
  return {
    state,
    async insertUser(user: NewConsoleUser): Promise<ConsoleUserRecord> {
      state.inserts += 1;
      state.inserted.push(user);
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        aclJson: user.aclJson,
        mfaRequired: user.mfaRequired,
        mfaEnabled: false,
        createTime: user.now,
        updateTime: user.now,
        updated: false,
      };
    },
    async listUsers(): Promise<readonly ConsoleUserRecord[]> {
      return [];
    },
    async readUserAcl(): Promise<string | null> {
      state.reads += 1;
      if (state.readFailures > 0) {
        state.readFailures -= 1;
        throw new SerializationFailure();
      }
      return state.targetAcl;
    },
    async updatePassword(_username: string, patch: PasswordPatch): Promise<boolean> {
      state.writes += 1;
      state.patches.push(patch);
      return true;
    },
    async writeAudit(entry: ConsoleAuditEntry): Promise<void> {
      state.audits += 1;
      state.auditEntries.push(entry);
    },
  };
}

/** 把一次调用折成状态码；没抛错就返回 `0`（上游测试里的 `codes.OK`）。 */
export async function codeOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 0;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

/** 把一次调用折成 {code, message}；用于逐字校验上游文案。 */
export async function statusOf(run: () => Promise<unknown>): Promise<{
  readonly code: number;
  readonly message: string;
}> {
  try {
    await run();
    return { code: 0, message: "" };
  } catch (error) {
    if (error instanceof ApiError) return { code: error.code, message: error.message };
    throw error;
  }
}
