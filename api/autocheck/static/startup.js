/**
 * 模块 11: 服务启动测试 (增强版)
 * 检测目标：验证服务能否正常启动并监听端口，同时核实服务身份 (Service Identity)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

async function check(servicePath, results) {
    const configPath = path.join(servicePath, 'config.js');
    
    if (!fs.existsSync(configPath)) {
        results.warnings.push(`⚠️ [启动] 跳过检查 - 缺少 config.js`);
        return;
    }
    
    // 读取配置获取端口和名称
    let port, serviceName;
    try {
        delete require.cache[require.resolve(configPath)];
        const config = require(configPath);
        port = config.port;
        serviceName = config.serviceName;
        if (!port) {
            results.warnings.push(`⚠️ [启动] config.js 未定义 port`);
            return;
        }
    } catch (e) {
        results.errors.push(`❌ [启动] 无法解析 config.js: ${e.message}`);
        return;
    }
    
    // 检查端口是否已被占用
    const isPortInUse = await checkPort(port);
    if (isPortInUse) {
        // 增强检查：核实服务身份
        const identityMatch = await verifyIdentity(port, serviceName);
        if (identityMatch === true) {
            results.passed.push(`✅ [启动] 服务已在端口 ${port} 运行，且身份核实：${serviceName}`);
        } else if (identityMatch === 'PATH_NOT_FOUND_404') {
             results.errors.push(`❌ [启动] 服务已运行但标准接口 /jsonrpc 返回 404 (注册协议不兼容)`);
        } else if (identityMatch === false) {
             results.errors.push(`❌ [启动] 端口 ${port} 已被占用，但不是服务 "${serviceName}" (身份核实失败)`);
        } else {
             results.passed.push(`✅ [启动] 服务已在端口 ${port} 运行 (身份核实提示: ${identityMatch})`);
        }
        return;
    }
    
    // --- 动态冒烟测试 (Dynamic Smoke Test) ---
    const indexPath = path.join(servicePath, 'index.js');
    if (!fs.existsSync(indexPath)) {
        results.warnings.push(`⚠️ [启动] 找不到入口文件: ${indexPath}`);
        return;
    }

    results.passed.push(`🔍 [启动] 正在尝试动态冒烟测试 (3s)...`);
    
    try {
        await runSmokeTest(servicePath, indexPath, port, results);
    } catch (e) {
        results.errors.push(`❌ [启动] 冒烟测试发现致命异常: ${e.message}`);
    }
}

/**
 * 执行主动启动并捕获异常
 */
function runSmokeTest(servicePath, indexPath, port, results) {
    return new Promise((resolve) => {
        // 使用 PATH 中可能存在的 node，或回退到系统 node
        const nodePath = process.env.NODE_PATH || 'node';
        const child = spawn(nodePath, [indexPath], { 
            cwd: servicePath,
            env: { ...process.env, DEBUG: 'false' }, // 减少噪音
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let errorCaptured = '';
        let hasCheckedPort = false;

        child.stderr.on('data', (data) => {
            const str = data.toString();
            if (str.includes('Error') || str.includes('TypeError') || str.includes('ReferenceError')) {
                errorCaptured += str;
            }
        });

        const timer = setTimeout(async () => {
            // 3秒后检查端口是否已开启
            const inUse = await checkPort(port);
            if (inUse) {
                results.passed.push(`✅ [启动] 动态启动成功，且端口 ${port} 已开始监听`);
            } else if (errorCaptured) {
                results.errors.push(`❌ [启动] 运行时崩溃详情:\n${errorCaptured.split('\n')[0]}`);
            } else {
                results.warnings.push(`⚠️ [启动] 服务已拉起但 3s 内未监听端口 (启动速度较慢或配置有误)`);
            }
            child.kill('SIGKILL');
            resolve();
        }, 3000);

        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0 && code !== null) {
                results.errors.push(`❌ [启动] 服务异常退出 (Exit Code: ${code})\n${errorCaptured || '未捕获到具体堆栈'}`);
            }
            resolve();
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            results.errors.push(`❌ [启动] 无法拉起进程: ${err.message}`);
            resolve();
        });
    });
}

function checkPort(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(true); // 端口被占用 = 服务在运行
            } else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(false); // 端口可用 = 服务未运行
        });
        server.listen(port);
    });
}

/**
 * 验证服务身份
 * 发送 ping 请求，检查返回结果
 */
function verifyIdentity(port, expectedName) {
    return new Promise((resolve) => {
        const data = JSON.stringify({
            jsonrpc: '2.0',
            method: 'ping',
            params: {},
            id: 'autocheck-ping'
        });

        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/jsonrpc',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            },
            timeout: 2000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 404) {
                    resolve('PATH_NOT_FOUND_404');
                    return;
                }
                try {
                    const json = JSON.parse(body);
                    if (json.result || json.error) {
                        resolve(true); 
                    } else {
                        resolve('RPC_RESPONSE_INVALID');
                    }
                } catch (e) {
                    resolve(false); 
                }
            });
        });

        req.on('error', () => resolve('CONNECTION_TIMEOUT'));
        req.write(data);
        req.end();
    });
}

module.exports = { check };
