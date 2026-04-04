#!/usr/bin/env node
/**
 * 测试事件系统
 */

const TeamDaemon = require('./agents/daemon.js');

// 创建一个测试 daemon
const daemon = new TeamDaemon('/tmp/test-project', { devs: 2 });

console.log('Testing event system...\n');

// 测试 1: on + emit
let count = 0;
daemon.on('test_event', (data) => {
  count++;
  console.log(`✓ Event received (${count}): ${JSON.stringify(data)}`);
});

daemon.emit('test_event', { message: 'hello' });
daemon.emit('test_event', { message: 'world' });

if (count === 2) {
  console.log('✓ Test 1 passed: on + emit\n');
} else {
  console.log('✗ Test 1 failed: expected 2 events, got ' + count + '\n');
  process.exit(1);
}

// 测试 2: once
let onceCount = 0;
daemon.once('once_event', () => {
  onceCount++;
  console.log('✓ Once event received');
});

daemon.emit('once_event');
daemon.emit('once_event');

if (onceCount === 1) {
  console.log('✓ Test 2 passed: once\n');
} else {
  console.log('✗ Test 2 failed: expected 1 event, got ' + onceCount + '\n');
  process.exit(1);
}

// 测试 3: off
let offCount = 0;
const handler = () => { offCount++; };
daemon.on('off_event', handler);
daemon.emit('off_event');
daemon.off('off_event', handler);
daemon.emit('off_event');

if (offCount === 1) {
  console.log('✓ Test 3 passed: off\n');
} else {
  console.log('✗ Test 3 failed: expected 1 event, got ' + offCount + '\n');
  process.exit(1);
}

console.log('✓ All tests passed!');
