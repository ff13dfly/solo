/**
 * kit 的入口 —— sample 与你自己的扩展都从这里取。
 *
 * 🔴 **路径必须是 `./kit/`，不能是 `../lib/`。** Chrome 扩展的根目录是封闭的树，
 *    越过根目录的 import 加载不到，而症状极坏：service worker 注册得起来、不报错，
 *    但模块从未求值，所有调用石沉大海。所以 kit 有一份**在扩展根内部**，
 *    由 `client/extension-kit/sync.sh` 同步进来。
 *
 * 因此复制本 sample 成你自己的扩展时，**这个文件一个字都不用改**——
 * 只要在新目录里跑一次 `bash ../extension-kit/sync.sh .` 就行。
 *
 * `messaging.js` 是唯一的例外形态：它**不用 import/export**，因为同一份文件还要被
 * manifest 当 classic script 注入进 content script（那边不认 module 语法）。
 * 它靠副作用挂 `globalThis.SoloMessaging`，在这里转成具名导出，用起来和别的模块一样。
 */
import './kit/messaging.js';
export const {
    isTransientChannelError, sendToTab, callBackground, serveMessages,
} = globalThis.SoloMessaging;

export * from './kit/rpc.js';
export * from './kit/queue.js';
export * from './kit/session.js';
export * from './kit/endpoints.js';
export * from './kit/storage.js';
export * from './kit/image.js';
