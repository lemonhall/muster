/**
 * 隔离区里的"宿主壳"源码：把租户模块装进一个独立 isolate，并把平台能力递进去。
 *
 * 这段代码**在隔离区里运行**，所以它只能是纯 JS 文本（不能 import 本仓库的任何 TS）；
 * 它由宿主拼进 `modules` 映射，作为被装载 Worker 的主模块。
 *
 * 三件事决定了它的形状：
 *
 * 1. **`InitModule` 只跑一次**（DoD 4）：`state.initialized` 是模块级变量，而 isolate
 *    在 `LOADER.get(key, ...)` 的同一个 key 上是复用的——于是"模块级状态跨调用保留"
 *    这件事由运行时自己保证，不是我们在宿主侧小心翼翼地缓存。
 * 2. **能力是每次调用现给的**：`nk` 与 `logger` 作为参数进来，不留在模块级变量里。
 *    留在模块级会让"上一个请求的 RpcTarget"被下一个请求复用，那是跨请求的状态泄漏。
 * 3. **租户模块靠静态 import 汇聚**（`muster-registry.js` 由宿主生成，每个模块一行
 *    `import * as mN from "./mod/N.js"`）：不用动态 `import()` 拼路径，模块映射就是
 *    唯一的真相来源，装载期就能发现"这个模块根本不存在"。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime.go::Runtime
 *
 * REQ-0001-020
 */

import type { TenantModule } from "./modules";

/** 被装载 Worker 的主模块名。宿主与桥两侧都用它，避免两处各写一遍。 */
export const HOST_MODULE = "muster-runtime.js";

/** 租户模块在模块映射里的目录前缀。 */
const MODULE_PREFIX = "mod/";

/**
 * 模块名能当 import 说明符用的形状。
 *
 * 上游 Lua 用 `require("stats")` 引另一个模块；ESM 的等价物是 `import * as stats
 * from "./stats.js"`。要让这件事成立，模块在映射里得**同时**有一份按名字的路径。
 * 但名字直接进路径就是一次路径穿越机会（`../`、绝对路径、空段……），所以只给
 * 匹配这个形状的名字开别名，其余模块仍然只能通过宿主分配的 `mod/<序号>.js` 装载。
 */
const SAFE_MODULE_NAME = /^[A-Za-z0-9_-]+$/u;

export const BRIDGE_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { registry } from "./muster-registry.js";

const state = {
  initialized: false,
  rpcs: new Map(),
  before: new Map(),
  after: new Map(),
  rtBefore: new Map(),
  rtAfter: new Map(),
};

// 上游把所有注册名与查找名都折成小写（strings.ToLower），所以
// registerRpc("HelloWorld") 能被 POST /v2/rpc/helloworld 找到。
function key(name) {
  return String(name).toLowerCase();
}

function messageOf(error) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (error.message !== undefined && error.message !== null) return String(error.message);
  return String(error);
}

// 隔离区里的 payload 一律是**字符串**：跨 RPC 传字符串没有编码歧义，
// 而"上游的 payload 本来就是 string"这一点两边是一致的。
function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function makeInitializer() {
  return {
    registerRpc: function (name, fn) { state.rpcs.set(key(name), fn); },
    registerBefore: function (op, fn) { state.before.set(key(op), fn); },
    registerAfter: function (op, fn) { state.after.set(key(op), fn); },
    registerRtBefore: function (op, fn) { state.rtBefore.set(key(op), fn); },
    registerRtAfter: function (op, fn) { state.rtAfter.set(key(op), fn); },
  };
}

function registrations() {
  return {
    rpc: Array.from(state.rpcs.keys()).sort(),
    before: Array.from(state.before.keys()).sort(),
    after: Array.from(state.after.keys()).sort(),
    rtBefore: Array.from(state.rtBefore.keys()).sort(),
    rtAfter: Array.from(state.rtAfter.keys()).sort(),
  };
}

// 模块级状态跨调用保留，所以这里的 initialized 真正等价于"isolate 只 InitModule 一次"。
async function ensureInit(host, ctx) {
  if (state.initialized) return;
  state.initialized = true;
  const initializer = makeInitializer();
  const names = Object.keys(registry).sort();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const mod = registry[name];
    if (mod === null || mod === undefined) continue;
    let entry = mod.InitModule;
    if (typeof entry !== "function" && mod.default) entry = mod.default.InitModule;
    if (typeof entry !== "function") continue;
    await entry(ctx, host.logger, host.nk, initializer);
  }
}

// 每次调用的入参形状：上游 InvokeFunction 拼的是 [ctx, logger, nk, ...payloads]，
// 也就是说模块**必须**从 handler 的参数里拿 nk/logger，而不是在 InitModule 里存一份。
//
// 本项目里这不是风格问题，是生命周期问题：能力对象是宿主为**这一次调用**现造的，
// 它背后的 RPC 会话在这次调用返回时就关闭了（实测：存下来的那一份再用就是
// "RPC stub used after being disposed"）。宁可让这类模块在第二次调用时大声失败，
// 也不能留一个"上一次请求的身份"继续可用——那正是跨请求的身份泄漏。
function callArgs(host, ctx, payloads) {
  return [ctx, host.logger, host.nk].concat(payloads);
}

function hookMap(kind) {
  if (kind === "before") return state.before;
  if (kind === "after") return state.after;
  if (kind === "rtBefore") return state.rtBefore;
  if (kind === "rtAfter") return state.rtAfter;
  return undefined;
}

export class RuntimeModuleHost extends WorkerEntrypoint {
  async setup(host, ctx) {
    await ensureInit(host, ctx);
    return registrations();
  }

  async describe() {
    return registrations();
  }

  async callRpc(host, ctx, name, payload) {
    await ensureInit(host, ctx);
    const fn = state.rpcs.get(key(name));
    if (typeof fn !== "function") {
      return { ok: false, missing: true, message: "RPC handler '" + name + "' is not registered." };
    }
    try {
      return { ok: true, payload: normalize(await fn.apply(null, callArgs(host, ctx, [payload]))) };
    } catch (error) {
      return { ok: false, missing: false, message: messageOf(error) };
    }
  }

  async callHook(host, ctx, kind, op, payload) {
    await ensureInit(host, ctx);
    const map = hookMap(kind);
    const fn = map === undefined ? undefined : map.get(key(op));
    if (typeof fn !== "function") return { registered: false };
    try {
      const out = await fn.apply(null, callArgs(host, ctx, [payload]));
      const allowed = out !== null && out !== undefined && out !== false;
      return { registered: true, allowed: allowed, payload: normalize(out) };
    } catch (error) {
      // 抛异常与"返回 falsy"是两回事：前者是模块写错了，后者是模块**故意**拒绝。
      // 宿主据此给不同的错误（500 系 vs 403 系），所以这里必须分开报。
      return { registered: true, allowed: false, failed: true, message: messageOf(error) };
    }
  }
}
`;

/**
 * 把租户模块拼成 Worker Loader 要的 `modules` 映射。
 *
 * 模块名**不参与路径**（路径是 `mod/<序号>.js`）：租户可以给模块起任何名字，
 * 而"名字里有 `/` 或 `.`"不该变成一次路径穿越尝试。
 */
export function buildModuleMap(modules: readonly TenantModule[]): {
  readonly modules: Record<string, string>;
  readonly names: readonly string[];
} {
  const map: Record<string, string> = {
    [HOST_MODULE]: BRIDGE_SOURCE,
  };
  const imports: string[] = [];
  const entries: string[] = [];
  modules.forEach((module, index) => {
    const path = `${MODULE_PREFIX}${index}.js`;
    map[path] = module.source;
    // 按名字的别名（同源的第二份路径）：让 `import "./stats.js"` 这种写法成立。
    if (SAFE_MODULE_NAME.test(module.name)) map[`${MODULE_PREFIX}${module.name}.js`] = module.source;
    imports.push(`import * as m${index} from "./${path}";`);
    entries.push(`${JSON.stringify(module.name)}: m${index}`);
  });
  map["muster-registry.js"] = `${imports.join("\n")}\nexport const registry = {${entries.join(",")}};\n`;
  return { modules: map, names: modules.map((module) => module.name) };
}
