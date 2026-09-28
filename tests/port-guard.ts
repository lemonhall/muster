import net from "node:net";

/**
 * 测试工装的"守夜人"：把 undici 的**禁用端口**在测试期间占住。
 *
 * 为什么需要它（2026-09-29 实测）：
 * `@cloudflare/vitest-pool-workers` 每启动一个测试文件，就让 miniflare 用
 * `server.listen(0)` 选一个临时端口做 loopback 服务，然后**用它自己内置的 undici**
 * 去 fetch 那个端口。undici 有一张写死的禁用端口清单（`6000` / `6666` / `10080` …，
 * `requestBadPort()` 在任何连接建立之前就拒掉），命中即抛 `Error: bad port`。
 * 后果不是"某条断言红了"，而是整个测试文件**启动失败**：
 * `Test Files 28 passed` + `Tests 213 passed` + `Errors 1 error`，退出码 1。
 *
 * 本机的动态端口范围是 `1024–15000`（`netsh int ipv4 show dynamicport tcp`），
 * 正好覆盖那张清单里的十几个端口（`1719 1720 1723 2049 3659 4045 4190 5060 5061
 * 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080`），于是一轮 `npm test`
 * 有百分之几的概率随机变红，而重跑就好——这种"随机红"是门禁最不该有的东西。
 *
 * 做法：在测试主进程里先把这些端口 bind 住，OS 就不会再把它分给 miniflare；
 * 拿不到就忽略（被真实服务占用、或落在这个机器的动态范围之外，本来就是安全的）。
 * 验证方式：`node -e "fetch('http://127.0.0.1:6666/')"` → `bad port`，
 * 而占住之后 miniflare 永远不会抽到它。
 *
 * 这是**环境补丁**，不是让步：它不让任何断言变宽松，也不改变被测代码路径。
 * 它同样挂在 E2E 通道上——`wrangler dev` 给 UserWorker 分配的也是随机端口，
 * 撞上禁用端口时整条 HTTP 通道会以 500 的形式随机变红。
 *
 * 契约源: 无（这是本项目自己的测试工装，不对应上游行为）
 */

/** undici `lib/core/util.js` 的 `badPortsSet`（写死在 undici 里，不可配置）。 */
const undiciBlockedPorts = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
];

/**
 * 只占这个区间里的端口：区间外的端口 OS 根本不会拿来当临时端口用
 * （而且 1024 以下还要管理员权限）。区间本身按本机 `netsh` 的实测值放宽取上界。
 */
const ephemeralRange = { start: 1024, end: 65535 };

function tryListen(port: number, host: string): Promise<net.Server | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const giveUp = () => resolve(undefined);
    server.once("error", giveUp);
    server.listen(port, host, () => {
      server.off("error", giveUp);
      // 占住之后不想让任何连接被挂住：来者一律立刻关掉。
      server.on("connection", (socket) => socket.destroy());
      server.on("error", () => {});
      resolve(server);
    });
  });
}

async function hold(port: number): Promise<net.Server[]> {
  const held: net.Server[] = [];
  for (const host of ["0.0.0.0", "::"]) {
    const server = await tryListen(port, host);
    if (server !== undefined) held.push(server);
  }
  return held;
}

/** 供 vitest `globalSetup` 使用：整个测试运行期间占住禁用端口，结束时释放。 */
export async function setup(): Promise<() => Promise<void>> {
  const targets = undiciBlockedPorts.filter(
    (port) => port >= ephemeralRange.start && port <= ephemeralRange.end,
  );
  const servers: net.Server[] = [];
  for (const port of targets) {
    servers.push(...(await hold(port)));
  }

  return async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  };
}
