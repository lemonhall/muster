# ECN-0012: 运行时扩展模块装载进独立 isolate（Worker Loader）

## 基本信息

- **ECN 编号**：ECN-0012
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-020（运行时扩展），并支撑 REQ-0001-019（派对）的匹配桥接
- **发现阶段**：v3-party-runtime（M8）设计时
- **日期**：2026-09-29

## 变更原因

上游的运行时扩展是**进程内的嵌入式脚本引擎**：同一个 Go 进程里起一个 goja（JS）或
gopher-lua（Lua）实例，模块文件从磁盘目录读进来，`nk.*` 是宿主注册进引擎的原生函数，
因此**同步**、且与被扩展的服务器共享内存。

workerd 上没有这两样东西：

1. **没有 `eval` / `new Function`**（除非打开 `unsafe-eval`，而生产不允许——打开它等于把
   整个 Worker 的隔离边界交给租户代码）。
2. **没有"同进程共享内存的原生函数"**：Worker 之间只能通过 RPC 通信，而 RPC 是异步的。

于是"把租户的代码装进平台"这件事在 Cloudflare 上有两种可行形态：

1. **构建期内联**：租户代码在部署时被打进同一个 Worker 包。代价是"一个租户一次部署"，
   与多租户（ECN-0001）目标直接冲突，而且租户代码与平台代码共享 isolate，隔离只剩"约定"。
2. **运行时动态装载**：用 Workers 的 **Worker Loader**（`env.LOADER.load(...)`）在运行时把
   租户的模块装进**一个新的 isolate**，再通过 RPC 把平台能力"递"进去。

选 2。它带来的额外好处正好是 REQ-0001-020 要的"隔离"：**一个租户的代码崩溃、死循环、
污染全局，都只影响它自己的 isolate**。

### 本地已验证的能力（不是推测）

在 M8 编码前用一次性探针（`LOADER.load` + RPC）在本地 workerd 上验证了三件事，随后删除探针：

1. `env.LOADER.load({ mainModule, modules })` 能装载一段运行时才生成的模块并调用其入口。
2. 装载进去的 isolate 能通过平台注入的能力对象**回调平台**（host → isolate 的参数里传
   `RpcTarget` 实例，isolate 侧 `await` 调用它的方法）。
3. 能力对象上的租户 id 来自**宿主侧闭包**：isolate 侧无论传什么参数都改不了它属于哪个租户。

## 变更内容

### 原设计

- 模块源码在磁盘目录里（`--runtime.path`），进程启动时装载一次。
- `nk.*` 是引擎内的同步原生函数，直接操作服务端内存与数据库。
- `InitModule(ctx, logger, nk, initializer)` 注册 RPC 与 hook。

### 新设计

- **模块源码进库**：`runtime_modules(tenant_id, name, source, revision, ...)`。
  源码是纯文本，`SELECT source FROM runtime_modules` 就能读出来——"一切皆文件"的
  D1 版本（见全局设计哲学：透明即信任）。
- **装载**：宿主按 `tenant_id:revision` 作为 Loader 的缓存键调用 `LOADER.get(key, getCode)`，
  拼装出主模块（`muster-host.js`）+ 租户模块（`mod/<name>.js`），装载进独立 isolate。
  同一个键只装载一次 → **模块级状态跨调用保留**，等价于上游"进程启动时装载一次"。
- **入口契约**：主模块导出带名字的入口类，宿主调用 `init(nk)`；主模块内部在 isolate 里
  找到租户模块导出的 `InitModule(ctx, logger, nk, initializer)` 并调用它。与上游 JS 运行时的
  入口签名逐字一致。
- **能力递送**：宿主为每个租户构造一个 `nk` 能力对象（`RpcTarget` 子类），在
  `init` 与每次调用时作为参数传进 isolate。能力对象内部持有**宿主侧解析出来的租户上下文**，
  隔离区无法伪造。
- **出口策略**：`globalOutbound: null`。租户模块**不能**直接 `fetch`；需要出网时必须走
  `nk.httpRequest`，由宿主代发。这样出口策略是平台可审计、可限流、可关停的。

## 偏差清单

| # | 偏差 | 为什么可接受 / 是否客户端可见 |
|---|---|---|
| 1 | 模块装载用 Worker Loader（每租户一个 isolate），不是进程内引擎 | **可见**（对模块作者）：模块之间无法共享内存；收益是代码级隔离。这正是 REQ-0001-020 指定要的 |
| 2 | `nk.*` 返回 Promise，必须 `await`；上游是同步调用 | **可见**（对模块作者）：跨 isolate 的 RPC 天然异步。登记为对模块作者的迁移成本 |
| 3 | 模块源码存 D1 而非磁盘目录，按 `tenant:revision` 拼装并缓存 | 不可见（部署形态差异）。revision 变化会换缓存键，模块更新不需要重启平台 |
| 4 | 只支持 JS（ESM），不支持 Lua | **可见**：上游 Lua 模块需要翻译成 JS。覆盖矩阵里 Lua 引擎（`internal/gopher-lua/*`）单独归 `LUA` 桶，明确不属于 v1~v4 |
| 5 | 模块间引用用 ESM `import`，不用 `require("stats")`；`require("nakama")` 的角色由 `InitModule` 的入参承担 | **可见**（对模块作者）：与上游 **JS** 运行时的入口形态一致，与 Lua 形态不同 |
| 6 | `bcryptHash` / `bcryptCompare` 用 PBKDF2-SHA256 | 不可见（哈希串是内部状态）。结论与理由沿用 [ECN-0002](./ECN-0002-password-hash.md)：workerd 没有 bcrypt，纯 JS 实现会把攻击者可控的 CPU 成本推高 |
| 7 | `aes128Encrypt` / `aes128Decrypt` 是自实现的 AES-128-CFB | **可见**（密文可互换）：算法、IV 前置、输入补齐到 4 的倍数、base64 标准编码都与上游一致；workerd 的 WebCrypto 没有 CFB 模式，所以块加密自实现 |
| 8 | "全局不可新增变量"改为"冻结平台注入的命名空间与既有全局对象" | **可见**（对模块作者）：上游这条是 goja 特有的不可扩展全局对象行为，标准 JS 没有对应语义。JS 等价面：冻结后改既有全局对象抛错、新建对象仍可变 |
| 9 | 配额走 workerd 的 `limits`（`cpuMs` / `subRequests`） | 不可见（阈值不同）。上游是单进程内的执行超时与栈深旋钮 |
| 10 | hook 注册只提供泛化形态 `registerBefore(op)` / `registerAfter(op)`（操作名沿用上游 API 名，如 `WriteStorageObjects`） | **可见**（对模块作者）：上游 JS 是逐操作 `registerBefore<Operation>`，Lua 是泛化形态；muster 提供泛化形态，逐操作版本可以后续作为语法糖补 |
| 11 | 未实现的 `nk.*`（`sqlExec`、`event`、`authenticate*`、`stream*` 等）**不存在**，调用会抛 `TypeError` | **可见**且**故意**：宁可让模块作者在装载时就撞到明确错误，也不返回 `undefined` 让错误延后到线上 |
| 12 | `ctx` 只提供 `userId` / `username` / `sessionId` / `executionMode` / `env` / `matchId` | **可见**：上游 `ctx` 的其余字段（节点 id、tick 速率一类）在本项目的载体上没有对应物 |
| 13 | 时间字段精度到秒（通知、钱包账本） | 与 ECN-0008 / ECN-0010 一致；同秒多条按 id 决胜 |

## 为什么这些偏差可接受

**对外部客户端完全不可见**：客户端看到的还是同一套 REST/WS 协议，RPC 的路径、payload 形状、
错误体形状都按上游对齐。

**对模块作者可见的四条**（偏差 1、2、4、5）都有明确的替代路径，且都是"把模块代码往标准
ESM/异步风格上收"这一个方向；这类代码在浏览器/Node 里也能跑，属于可移植性提升而非损失。

**多租户语义变强而不是变弱**：上游是"一个进程一个游戏"；muster 是"一个租户一个 isolate"，
所以同账号下多个游戏的代码与数据同时隔离（REQ-0001-026 的代码侧延伸）。

## 影响范围

- 受影响的 Req ID：REQ-0001-020（验收口径不变：RPC 能被客户端调用、hook 能拦请求）。
- 受影响的计划：[v3-party-runtime.md](../plan/v3-party-runtime.md)（M8）的 DoD 4/5 直接对应本文。
- 受影响的代码：`src/runtime/*`、`migrations/0006_runtime.sql`、`wrangler.jsonc`（新增 `worker_loaders` 绑定）。
- 受影响的测试：运行时那一组测试全部按**异步**写；隔离性用跨租户负向断言钉住。

## 处置方式

- [x] PRD 已同步（REQ-0001-019 / 020 的偏差备注）
- [x] vN 计划已同步（v3-party-runtime.md 的 Scope / Risks / DoD）
- [x] 追溯矩阵已同步（ECN 索引）
- [x] 相关测试已同步（`tests/integration/runtime/`、`tests/unit/runtime/`）
