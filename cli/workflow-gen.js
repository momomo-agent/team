#!/usr/bin/env node
/**
 * Workflow Generator — Phase 3: 自组织团队
 * 
 * 给一句话目标，LLM 自动生成 workflow config + nodes + prompts
 * 然后 engine 直接跑。
 * 
 * Usage: node workflow-gen.js "对这个项目做安全审计并输出报告" [--project /path]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TEAM_ROOT = path.join(__dirname, '..');
const AUTO_DIR = path.join(TEAM_ROOT, 'configs', '_auto');

const SCHEMA_PROMPT = `你是一个 workflow 架构师。根据用户的目标，设计一个多 agent 工作流。

## Engine 能力

Node types:
- sequence: 按顺序执行 steps，完成后走 next
- loop: 重复执行 steps 直到 exit 条件满足，max 限制最大迭代

Step 字段:
- id: 唯一标识
- when: 前置条件表达式（引用 context 变量），不满足则跳过
- execute: { type: "agent"|"shell"|"noop", agent: "agent_name", command: "shell cmd" }
- agents: ["a", "b", "c"] + parallel: true — 多 agent 并行
- demand: 并行实例数表达式
- post: { tasks_in: "status", must_become: "new_status" } — 后置状态保证

Next 可以是:
- 字符串: "node_name"
- 条件: { "if": "ctx_var", "then": "node_a", "else": "node_b" }

Context 变量: 可引用 tasks.byStatus('x').length, files.exists('path'), gaps.read('name').match 等

Shell steps: 可执行任意 shell 命令（收集信息、生成文件等）

## 约束
- agent prompt 写成 markdown，告诉 agent 它的角色、要读什么文件、输出什么
- model 统一用 "claude-sonnet-4"
- 生成的文件会存到 configs/_auto/ 目录
- 所有路径必须是相对路径（相对项目根目录），不要用绝对路径
- requiredFiles 用相对路径如 "package.json"
- docs.root 固定用 ".team/docs"
- shell command 中用相对路径，假设 cwd 是项目根目录

## 输出格式
严格输出 JSON，不要任何解释文字。结构:

{
  "config": {
    "version": "1.0",
    "description": "...",
    "requiredFiles": [],
    "goal": { "condition": "...", "description": "..." },
    "workflow": {
      "entry": "first_node",
      "context": { "var_name": "expression" },
      "nodes": { "node_name": "nodes/node_name.json" }
    },
    "agents": {
      "agent_name": {
        "prompt": "prompts/agent_name.md",
        "model": "claude-sonnet-4"
      }
    },
    "docs": { "root": ".team/docs" }
  },
  "nodes": {
    "node_name.json": { "type": "sequence|loop", "steps": [...], "next": "..." }
  },
  "prompts": {
    "agent_name.md": "# Role\\n\\n你是...\\n\\n## 任务\\n\\n..."
  }
}

## Dashboard 配置

config 里必须包含 dashboard 字段，定义可视化面板。格式：

{
  "dashboard": {
    "left": [
      {
        "title": "Tab显示名",
        "components": [
          {
            "component": "MarkdownView",
            "path": "相对路径.md",
            "gapKey": "对应的gap名",
            "label": "显示标签"
          }
        ],
        "badge": {
          "source": ".team/gaps/xxx.json",
          "field": "match"
        }
      }
    ],
    "right": [
      {
        "title": "Pipeline",
        "components": [{ "component": "KanbanBoard" }]
      },
      {
        "title": "Agents",
        "components": [{ "component": "AgentStatus" }]
      }
    ]
  }
}

可用的 component 类型：
- MarkdownView: 显示 markdown 文件，path 指定文件路径，gapKey 关联 gap 数据
- KanbanBoard: 看板视图，显示所有 task 状态
- AgentStatus: agent 运行状态面板
- GapsList: gap 列表，source 指定 gap JSON 路径

根据项目目标，左侧 tabs 应该包含项目的核心文档（如 Vision、PRD、验收标准等），
右侧固定放 Pipeline 和 Agents。每个文档 tab 要关联对应的 gap monitor。`;

async function generate(goal, projectDir) {
  console.log(`\n🎯 目标: ${goal}`);
  console.log(`📁 项目: ${projectDir || '(当前目录)'}\n`);

  // 收集项目上下文
  let projectContext = '';
  if (projectDir && fs.existsSync(projectDir)) {
    try {
      const files = execSync(`find ${projectDir} -maxdepth 2 -type f -name '*.js' -o -name '*.ts' -o -name '*.md' -o -name '*.json' | head -30`, { encoding: 'utf8' });
      projectContext = `\n项目文件:\n${files}`;
    } catch {}
    
    // 读 README 或 package.json
    for (const f of ['README.md', 'package.json']) {
      const fp = path.join(projectDir, f);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf8').slice(0, 2000);
        projectContext += `\n--- ${f} ---\n${content}\n`;
      }
    }
  }

  const userPrompt = `目标: ${goal}${projectContext}\n\n请设计 workflow。只输出 JSON。`;

  // 调用 LLM
  console.log('🤖 生成 workflow...\n');
  
  const tmpInput = '/tmp/team-gen-input.txt';
  fs.writeFileSync(tmpInput, userPrompt);
  
  let result;
  try {
    result = execSync(
      `llm --system ${JSON.stringify(SCHEMA_PROMPT)} --max-tokens 4000 < ${tmpInput}`,
      { encoding: 'utf8', timeout: 120000 }
    );
  } catch (e) {
    console.error('❌ LLM 调用失败:', e.message);
    process.exit(1);
  }

  // 解析 JSON
  let workflow;
  try {
    // 提取 JSON（可能包裹在 ```json ``` 里）
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    workflow = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('❌ JSON 解析失败:', e.message);
    console.error('原始输出:\n', result.slice(0, 500));
    process.exit(1);
  }

  // 写文件
  fs.rmSync(AUTO_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(AUTO_DIR, 'nodes'), { recursive: true });

  // config.json
  fs.writeFileSync(
    path.join(AUTO_DIR, 'config.json'),
    JSON.stringify(workflow.config, null, 2)
  );
  console.log('  ✓ config.json');

  // nodes
  for (const [name, node] of Object.entries(workflow.nodes || {})) {
    fs.writeFileSync(
      path.join(AUTO_DIR, 'nodes', name),
      JSON.stringify(node, null, 2)
    );
    console.log(`  ✓ nodes/${name}`);
  }

  // prompts → 写到 team 全局 prompts 目录（agents 共享）
  const promptsDir = path.join(TEAM_ROOT, 'prompts');
  for (const [name, content] of Object.entries(workflow.prompts || {})) {
    const promptPath = path.join(promptsDir, name);
    if (!fs.existsSync(promptPath)) {
      fs.writeFileSync(promptPath, content);
      console.log(`  ✓ prompts/${name} (new)`);
    } else {
      console.log(`  ⊘ prompts/${name} (exists, skipped)`);
    }
  }

  // ─── Validate generated workflow ───
  const { validate } = require('../lib/workflow-validator');
  let valResult = validate(workflow.config, { configDir: AUTO_DIR });

  // ─── Auto-fix loop: feed errors back to LLM ───
  const MAX_FIX_ATTEMPTS = 3;
  let fixAttempt = 0;

  while (!valResult.valid && fixAttempt < MAX_FIX_ATTEMPTS) {
    fixAttempt++;
    console.log(`\n🔧 Auto-fix attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS}...`);

    const errorList = valResult.errors.map(e => e.toString()).join('\n');
    const fixPrompt = `你之前生成的 workflow 有以下验证错误:\n\n${errorList}\n\n` +
      `当前 workflow JSON:\n${JSON.stringify(workflow, null, 2)}\n\n` +
      `请修复这些错误，输出完整的修正后 JSON。只输出 JSON，不要解释。`;

    fs.writeFileSync(tmpInput, fixPrompt);

    let fixResult;
    try {
      fixResult = execSync(
        `llm --system ${JSON.stringify(SCHEMA_PROMPT)} --max-tokens 4000 < ${tmpInput}`,
        { encoding: 'utf8', timeout: 120000 }
      );
    } catch (e) {
      console.error('  ❌ LLM fix call failed:', e.message);
      break;
    }

    try {
      const jsonMatch = fixResult.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');
      const fixed = JSON.parse(jsonMatch[0]);
      workflow = fixed;

      // Re-write files
      fs.writeFileSync(path.join(AUTO_DIR, 'config.json'), JSON.stringify(workflow.config, null, 2));
      for (const [name, node] of Object.entries(workflow.nodes || {})) {
        fs.writeFileSync(path.join(AUTO_DIR, 'nodes', name), JSON.stringify(node, null, 2));
      }

      // Re-validate
      valResult = validate(workflow.config, { configDir: AUTO_DIR });

      if (valResult.valid) {
        console.log('  ✅ Fixed!');
      } else {
        console.log(`  Still ${valResult.errors.length} errors remaining`);
      }
    } catch (e) {
      console.error('  ❌ Fix parse failed:', e.message);
      break;
    }
  }

  if (valResult.errors.length > 0) {
    console.log('\n❌ Validation errors (unfixed):');
    valResult.errors.forEach(e => console.log('  ' + e.toString()));
    console.log('\nWorkflow written but has errors. Fix manually before running.');
  }
  if (valResult.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    valResult.warnings.forEach(e => console.log('  ' + e.toString()));
  }
  if (valResult.valid) {
    console.log('\n✅ Validation passed');
  }

  // 摘要
  const agentCount = Object.keys(workflow.config.agents || {}).length;
  const nodeCount = Object.keys(workflow.nodes || {}).length;
  console.log(`\n✅ Workflow 生成完成: ${agentCount} agents, ${nodeCount} nodes`);
  console.log(`   configs/_auto/`);
  console.log(`\n启动:`);
  console.log(`   team init <dir> --config _auto`);
  console.log(`   cd <dir> && team start`);

  return workflow;
}

// CLI
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage: node workflow-gen.js "<goal>" [--project /path]');
  console.log('       team auto "<goal>" [--project /path]');
  process.exit(0);
}

const goal = args[0];
const projIdx = args.indexOf('--project');
const projectDir = projIdx !== -1 ? args[projIdx + 1] : process.cwd();

generate(goal, projectDir);
