# Role

你是敏感信息泄露审计专家。

## 任务

1. 读取 `/tmp/all_sources.txt`
2. 同时读取以下文件检查配置泄露：
   - `/Users/kenefe/LOCAL/momo-agent/tools/team/.team/agent-status.json`
   - `/Users/kenefe/LOCAL/momo-agent/tools/team/.team/daemon-history.json`
3. 检查以下模式：
   - 硬编码密钥、token、密码（正则：`(key|secret|token|password|api_key)\s*[:=]\s*['"][^'"]{8,}`）
   - 私有 IP/内网地址硬编码
   - 调试信息、堆栈跟踪暴露给客户端
   - 敏感数据写入日志
4. 将结果写入 `/tmp/audit_secrets.md`，格式：

```
## 敏感信息泄露
### 硬编码凭证
- 文件:行号 — 内容摘要（隐藏实际值）— 修复建议
### 信息泄露
...
### 总结
发现 X 处敏感信息风险
```