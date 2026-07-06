# Agent 测试说明

## 测试文件

| 文件 | 用途 | 运行方式 |
|:---|:---|:---|
| `focus.test.js` | Focus 状态参数提取测试 | `node focus.test.js` |
| `purpose.test.js` | Purpose 意图识别测试 | `node purpose.test.js` |
| `purpose_phase1.test.js` | Purpose Phase 1 粗筛测试 | `node purpose_phase1.test.js` |
| `purpose_phase1_mock.test.js` | Purpose Phase 1 Mock 测试 | `node purpose_phase1_mock.test.js` |
| `flow.test.js` | 端到端流程验证 | `node flow.test.js` |

## 归档文件

`archive/` 目录包含历史测试记录和废弃脚本，保留供参考。

## 运行所有测试

```bash
cd api/agent/tests
node focus.test.js
node purpose.test.js
```

## 注意事项

1. AI 测试结果有不确定性，断言使用模糊匹配
2. 测试前确保 Agent 服务运行在 port 8730
3. 需要有效的 DASHSCOPE_API_KEY 环境变量
