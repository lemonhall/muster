import { describe, expect, it } from "vitest";

import { parseCron } from "../../../src/domain/competitive/cron/expression";
import { calculateTournamentDeadlines } from "../../../src/domain/competitive/tournament/deadlines";

/**
 * 锦标赛当期窗口的四个边界。
 *
 * 这四条是上游 `core_tournament_test.go` 的全部内容，也是 `calculateTournamentDeadlines`
 * 唯一的规格说明：每条都钉死三个返回值中的两到三个。用例里的数字是上游原文抄过来的
 * （`1692090000` 就是 2023-08-15T09:00:00Z），不改成"看起来更整齐"的值——
 * 它们的价值正是"跨月、跨周、夏令时无关"的多样化时刻。
 *
 * 溯源: server/core_tournament_test.go::TestTournamentEveryFourteenDaysFromFirst
 * 溯源: server/core_tournament_test.go::TestTournamentEveryDayMonThruFri
 * 溯源: server/core_tournament_test.go::TestTournamentNowIsResetTime
 * 溯源: server/core_tournament_test.go::TestTournamentNowIsBeforeStart
 */

function at(seconds: number): Date {
  return new Date(seconds * 1000);
}

describe("calculateTournamentDeadlines", () => {
  it("每 14 天一次的赛程：从第一次重置起算", () => {
    const schedule = parseCron("0 9 */14 * *");
    const now = 1692608400; // 2023-08-21T11:00:00Z
    const deadlines = calculateTournamentDeadlines(1692090000, 0, 1202400, schedule, at(now));

    expect(deadlines.startActive).toBe(1692090000); // 2023-08-15T09:00:00Z
    expect(deadlines.endActive).toBe(1693292400); // 2023-08-29T07:00:00Z
    expect(Math.floor(schedule.next(at(now)).getTime() / 1000)).toBe(1693299600); // 2023-08-29T09:00:00Z
  });

  it("工作日每晚 22 点：周末不重置", () => {
    const schedule = parseCron("0 22 * * 1-5");
    const now = 1692615600; // 2023-08-21T11:00:00Z（周一）
    const deadlines = calculateTournamentDeadlines(1692090000, 0, 7200, schedule, at(now));

    expect(deadlines.startActive).toBe(1692396000); // 2023-08-18T22:00:00Z（周五）
    expect(deadlines.endActive).toBe(1692403200); // 2023-08-19T00:00:00Z
    expect(Math.floor(schedule.next(at(now)).getTime() / 1000)).toBe(1692655200); // 2023-08-21T22:00:00Z
  });

  it("当前时刻正好落在重置点上", () => {
    const schedule = parseCron("0 9 14 * *");
    const now = 1692003600; // 2023-08-14T09:00:00Z
    const deadlines = calculateTournamentDeadlines(1692003600, 0, 604800, schedule, at(now));

    expect(deadlines.startActive).toBe(1692003600);
    expect(deadlines.endActive).toBe(1692608400); // 2023-08-21T09:00:00Z
    expect(Math.floor(schedule.next(at(now)).getTime() / 1000)).toBe(1694682000); // 2023-09-14T09:00:00Z
  });

  it("当前时刻早于开赛时间：从开赛后的第一个重置点起算", () => {
    const schedule = parseCron("0 9 14 * *");
    const now = 1692003600; // 2023-08-14T09:00:00Z
    const deadlines = calculateTournamentDeadlines(1693558800, 0, 604800 * 4, schedule, at(now));

    expect(deadlines.startActive).toBe(1694682000); // 2023-09-14T09:00:00Z
    expect(deadlines.endActive).toBe(1697101200); // 2023-10-12T09:00:00Z
  });
});
