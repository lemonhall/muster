import { describe, expect, it } from "vitest";

/**
 * M0 DoD 反作弊条款 2 的**永久化门禁**：证明这套单元/集成测试确实跑在 workerd 里。
 *
 * 由来：计划里写了"若配置回退到 node 环境运行，M0 不算完成"。这句话如果只靠
 * 人记得，就会在某次依赖升级后被静默打破；所以把它变成一条会红的测试。
 * workerd 的 `navigator.userAgent` 是固定的 `Cloudflare-Workers`，node 下不是。
 *
 * REQ-0001-001
 */
describe("M0 运行时身份", () => {
  it("test_unit_tests_run_inside_real_workerd_runtime", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });
});
