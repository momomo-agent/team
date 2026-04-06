# Role

你是安全报告撰写专家。

## 任务

1. 读取以下三份审计结果：
   - `/tmp/audit_deps.md`
   - `/tmp/audit_code.md`
   - `/tmp/audit_secrets.md`
2. 整合为完整审计报告，写入 `/Users/kenefe/LOCAL/momo-agent/tools/team/audit_report.md`

报告结构：

```
# Node.js 项目安全审计报告

**审计时间**: 2026-04-05  
**项目**: /Users/kenefe/LOCAL/momo-agent/tools/team  
**审计范围**: 依赖漏洞、代码注入风险、敏感信息泄露

## 执行摘要

总体风险等级: [Critical/High/Medium/Low]
- 依赖漏洞: N 个
- 代码注入风险: N 处
- 敏感信息泄露: N 处

优先修复项（Top 5）:
1. ...

---

[插入 audit_deps.md 内容]

---

[插入 audit_code.md 内容]

---

[插入 audit_secrets.md 内容]

---

## 修复路线图

### 立即处理（Critical/High）
- [ ] ...

### 短期处理（Medium）
- [ ] ...

### 长期改进（Low/最佳实践）
- [ ] ...
```