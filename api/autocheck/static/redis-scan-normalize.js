/**
 * 模块: SCAN 迭代器批次归一化检查
 * 检测目标：`for await (const x of redis.xScanIterator(...))` 循环体内是否有
 *          `Array.isArray(x)` 归一化。
 *
 * @why node-redis v4 的 scanIterator/sScanIterator/hScanIterator/zScanIterator
 *      逐条 yield 单个成员，v5（本项目在用）逐批 yield 一整个 SCAN 批次（数组）。
 *      漏了归一化不会在 hermetic 单测里暴露——自建的 fake redis 通常按"单值"
 *      的旧假设实现，跟被测代码共享同一个错误前提；只有跑真实 Redis 且数据量
 *      大到产生多个 SCAN 批次时才会丢数据。已有正确写法见
 *      core/nexus/logic/events.js:38。
 *
 * 范围：优先扫 <servicePath>/logic/*.js（服务标准布局）；若没有 logic/ 子目录
 *      （如 api/library 这种扁平库目录），退化为直接扫 <servicePath> 自身的
 *      *.js——这个退化是刻意加的，此前 entity.js 的全量拉取反模式能在
 *      api/library 里潜伏一整个版本没被 pagination-safety 抓到，根因就是所有
 *      静态检查只认 logic/ 子目录，从没被指向过 api/library。
 */

const fs = require('fs');
const path = require('path');

const LOOP_PATTERN = /for\s+await\s*\(\s*const\s+(\w+)\s+of\s+[\w.]*\.(?:scanIterator|sScanIterator|hScanIterator|zScanIterator)\s*\(/;
const LOOKAHEAD_LINES = 6;

function collectFiles(servicePath) {
    const logicPath = path.join(servicePath, 'logic');
    const dir = fs.existsSync(logicPath) ? logicPath : servicePath;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(dir, f));
}

function check(servicePath, results) {
    collectFiles(servicePath).forEach(filePath => scanFile(filePath, results));
}

function scanFile(filePath, results) {
    const fileName = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, i) => {
        if (line.includes('// SAFE:')) return;
        const m = LOOP_PATTERN.exec(line);
        if (!m) return;

        const varName = m[1];
        const windowEnd = Math.min(lines.length, i + 1 + LOOKAHEAD_LINES);
        const window = lines.slice(i, windowEnd).join('\n');
        const normalized = new RegExp(`Array\\.isArray\\s*\\(\\s*${varName}\\s*\\)`);

        if (!normalized.test(window)) {
            results.warnings.push(
                `⚠️ [Redis-SCAN] ${fileName}:${i + 1}: \`${varName}\` 来自 ScanIterator 但未见 \`Array.isArray(${varName})\` 归一化——` +
                `node-redis v5 下 scanIterator/sScanIterator/hScanIterator/zScanIterator 逐批 yield 数组而非单值（v4 是单值），` +
                `数据量大到产生多个 SCAN 批次时会丢数据。参考 core/nexus/logic/events.js 的写法，` +
                `或确认上游已保证单批后在该行加 \`// SAFE:\` 豁免。`
            );
        }
    });
}

module.exports = { check };
