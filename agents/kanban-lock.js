/**
 * Kanban 文件锁工具
 * 防止并发读写导致数据损坏
 */

const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

/**
 * 安全读取 kanban
 */
async function readKanban(projectDir) {
  const kanbanPath = path.join(projectDir, '.team/kanban.json');
  
  if (!fs.existsSync(kanbanPath)) {
    return { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
  }
  
  let release;
  try {
    release = await lockfile.lock(kanbanPath, { 
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
      stale: 10000
    });
    
    const content = fs.readFileSync(kanbanPath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    // 锁失败，降级到无锁读取
    console.warn('[kanban-lock] Lock failed, fallback to unlocked read:', err.message);
    const content = fs.readFileSync(kanbanPath, 'utf8');
    return JSON.parse(content);
  } finally {
    if (release) await release();
  }
}

/**
 * 安全更新 kanban
 */
async function updateKanban(projectDir, updateFn) {
  const kanbanPath = path.join(projectDir, '.team/kanban.json');
  
  let release;
  try {
    release = await lockfile.lock(kanbanPath, { 
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
      stale: 10000
    });
    
    const kanban = fs.existsSync(kanbanPath)
      ? JSON.parse(fs.readFileSync(kanbanPath, 'utf8'))
      : { todo: [], inProgress: [], blocked: [], review: [], testing: [], done: [] };
    
    updateFn(kanban);
    
    fs.writeFileSync(kanbanPath, JSON.stringify(kanban, null, 2));
    return kanban;
  } finally {
    if (release) await release();
  }
}

module.exports = { readKanban, updateKanban };
