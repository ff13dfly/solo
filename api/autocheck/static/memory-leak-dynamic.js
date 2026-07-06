/**
 * 模块 16: 动态内存泄漏检测
 * 检测目标：通过高频请求观察服务内存增长情况
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

async function check(servicePath, results) {
    const configPath = path.join(servicePath, 'config.js');
    const indexPath = path.join(servicePath, 'index.js');
    
    if (!fs.existsSync(configPath) || !fs.existsSync(indexPath)) {
        return;
    }

    // 1. 获取端口
    let port;
    try {
        delete require.cache[require.resolve(configPath)];
        const config = require(configPath);
        port = config.port;
    } catch (e) {
        return;
    }

    // 2. 检查服务是否已运行
    const isRunning = await isPortOpen(port);
    if (!isRunning) {
        results.warnings.push(`⚠️ [内存-动态] 服务未运行，跳过动态内存检测`);
        return;
    }

    // 3. 找到进程 PID
    let pid;
    try {
        const { execSync } = require('child_process');
        const lsof = execSync(`lsof -t -i:${port}`).toString().trim();
        pid = lsof.split('\n')[0];
    } catch (e) {
        results.warnings.push(`⚠️ [内存-动态] 无法获取服务 PID，跳过内存监控`);
        return;
    }

    // 执行压测并采样
    try {
        const stats = await runPressureTest(port, pid, 300); // 发送 300 个请求
        
        // 允许 50MB 的抖动/增长 (Node.js V8 延迟 GC 特性)
        if (stats.growth > 51200) {
            results.errors.push(`❌ [内存-动态] 压测发现内存异常增长: ${(stats.growth/1024).toFixed(2)}MB (可能存在内存泄漏)`);
        } else {
            results.passed.push(`✅ [内存-动态] 压测完成，内存稳定 (增长: ${(stats.growth/1024).toFixed(2)}MB)`);
        }
    } catch (e) {
        results.warnings.push(`⚠️ [内存-动态] 压测过程出错: ${e.message}`);
    }
}

function isPortOpen(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/auth/seed`, (res) => {
            res.on('data', () => {});
            resolve(true);
        }).on('error', () => {
            resolve(false);
        });
        req.setTimeout(1000);
    });
}

function getProcessMemory(pid) {
    try {
        const { execSync } = require('child_process');
        // 获取 RSS 内存 (KB)
        const rss = execSync(`ps -o rss= -p ${pid}`).toString().trim();
        return parseInt(rss);
    } catch (e) {
        return 0;
    }
}

function runPressureTest(port, pid, count) {
    return new Promise((resolve, reject) => {
        let completed = 0;
        const startMem = getProcessMemory(pid);
        
        const sendRequest = () => {
            const postData = JSON.stringify({
                jsonrpc: "2.0",
                method: "ping",
                params: {},
                id: 1
            });

            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/jsonrpc',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length
                }
            };

            const req = http.request(options, (res) => {
                res.on('data', () => {});
                res.on('end', () => {
                    completed++;
                    if (completed < count) {
                        sendRequest();
                    } else {
                        // 结束再次测量内存
                        setTimeout(() => {
                            const endMem = getProcessMemory(pid);
                            resolve({ 
                                leakFound: (endMem - startMem > 51200), 
                                growth: Math.max(0, endMem - startMem) 
                            });
                        }, 1000);
                    }
                });
            });

            req.on('error', (e) => reject(e));
            req.write(postData);
            req.end();
        };

        if (startMem === 0) return reject(new Error("Cannot read memory"));
        sendRequest();
    });
}

module.exports = { check };
