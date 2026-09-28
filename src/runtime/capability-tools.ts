/**
 * `nk` 的**纯函数面**：摘要、编解码、AES、口令哈希、UUID、JSON、bit32。
 *
 * 这一层没有任何 I/O，所以它不需要租户上下文——把它与数据面分开，是为了让
 * "哪些能力天然安全、哪些能力必须带租户"在文件边界上就能看出来。
 *
 * 返回的是**普通对象 + 函数**：宿主把它作为参数交给隔离区，workerd 的 RPC 会把
 * 里面的每个函数 stub 化（实测：类实例会 `DataCloneError`，普通对象不会）。
 * 于是隔离区里 `await nk.md5Hash("test")` 这件事，实际执行的是宿主侧的这一个函数。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.md5Hash
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.uuidv4
 * 契约源: server/runtime_lua_nakama.go::RuntimeLuaNakamaModule.jsonEncode
 *
 * REQ-0001-020
 */

import { bit32 } from "./bit32";
import {
  aes128Decrypt,
  aes128Encrypt,
  base16Decode,
  base16Encode,
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  bcryptCompare,
  bcryptHash,
  md5Hash,
  sha256Hash,
  uuidv4,
} from "./crypto";
import { jsonDecode, jsonEncode } from "./json";

/**
 * 把纯函数面拼成一个对象。键名与上游 JS 运行时的 `nk` 逐字一致（大小写也一样），
 * 因为模块作者是从上游文档抄过来的。
 *
 * `bit32` 是**嵌套的普通对象**：上游 `bit32.band(...)` 的调用形态必须保留。
 */
export function buildNkTools(): Record<string, unknown> {
  return {
    md5Hash,
    sha256Hash,
    base64Encode,
    base64Decode,
    base64UrlEncode,
    base64UrlDecode,
    base16Encode,
    base16Decode,
    aes128Encrypt,
    aes128Decrypt,
    bcryptHash,
    bcryptCompare,
    uuidv4,
    jsonEncode,
    jsonDecode,
    bit32,
  };
}
