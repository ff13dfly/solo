# child-process-safety 把 `RegExp.prototype.exec` 判成命令注入（ERROR，且逼人改写等价代码绕过）

- **来源**：catalog，2026-09-17，「双 ERP 商品主数据差分导入」落地实测
- **场景**：服务 logic 层用 `spawn(bin, [args])` 起一个 python 子进程做 xlsx 解析与差分
  比对（Router 转发超时 10s，解析要几十秒，只能异步）。同一个文件里另有一处用正则从
  连接串里取库名。
- **依据分类**：以下**全部为本次实测**（catalog 栈，bundle v1.2.14，本机 macOS）。
- **级别**：ERROR —— `checker.js --static` 直接 FAILED，挡住部署。

## 实测现象

这一行被判 ERROR：

```js
const m = /\/([^/?]+)(\?|$)/.exec(config.pgUrl || '');   // 从连接串里取库名
```

```
❌ [ChildProcess] logic/importer.js:27: exec() 参数包含变量或拼接，存在命令注入风险。
   请改用 execFile(file, args[]) 将命令与参数分离。
⚠️ [ChildProcess] logic/importer.js:27: exec() 未设置 timeout 选项，子进程挂死时会阻塞服务。
```

这是 **`RegExp.prototype.exec`**，与 `child_process` 毫无关系。这个文件里**没有任何
`exec()` 调用**，起子进程用的是 `spawn(config.pythonBin, [SCRIPT, ...args], {...})` ——
参数数组分离、不经 shell，正是规则希望人写成的形状。

**同一个文件里真正起子进程的那几行，规则一条都没说话。**

## 根因

`api/autocheck/static/child-process-safety.js:43`

```js
if (/\bexec\s*\(/.test(line)) {
```

按**方法名字面**匹配，不看调用者、也不看文件有没有 `require('child_process')`。
`\b` 词边界在 `.exec(` 上是成立的（`.` 非单词字符），所以任何 `<任意对象>.exec(` 都命中：
`RegExp.prototype.exec` 是最常见的一个，此外还有各类 DSL/ORM 的 `.exec()`（mongoose 的
query.exec() 是另一个会中招的高频写法）。

`:45` 的豁免只认纯字符串字面量 `exec('fixed')`，正则字面量不在其中。

## 为什么值得修（不只是"多一条红"）

误报把作者推向**改写等价代码去绕过**。我这次的处理就是把 `/re/.exec(s)` 改成
`s.match(/re/)` —— 两者对非全局正则完全等价，改完门禁就绿了。但这意味着：

1. 规则在这里**没有防住任何东西**，只是让代码换了个写法；
2. 它与「不许靠改名绕过门禁」这条纪律直接冲突 —— 这次是规则本身逼人绕；
3. **真正的风险面仍然是漏的**：`:74` 只查 `spawn({shell:true})`，而
   `execFile` / `execSync` / `spawnSync` 拼接参数都不在检查里。一个把 `exec` 误判到
   正则上、却看不见真子进程调用的规则，给出的是**反向的**安全信号。

## 建议（按价值排序）

1. **先判文件有没有引入 child_process，没有就整条规则跳过。**
   零误报成本，一行前置：
   ```js
   if (!/require\(['"]child_process['"]\)|from\s+['"]child_process['"]/.test(content)) return;
   ```
   绝大多数误报（正则、mongoose、各类 builder）一次消掉。
2. **把调用者绑进匹配**：从 require 的解构/赋值里收集实际绑定名
   （`const { exec } = require('child_process')` → `exec`；
   `const cp = require('child_process')` → `cp.exec`），只对这些名字报警。
3. **补齐漏报面**：`execSync` / `spawnSync` / `execFile` 的命令参数含拼接时同样该报；
   `spawn(a, b)` 的 **b 不是数组**时（等价于走 shell 解析）才是真正要拦的形状。
4. 文案里补一句「本规则只针对 child_process 的 exec」，让撞上误报的人不必去读规则源码
   才敢判断它是误报。

## 处理结论

（待 triage）
