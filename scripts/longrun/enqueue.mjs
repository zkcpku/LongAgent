#!/usr/bin/env node
import {
  requireState,
  readJsonl,
  writeJsonl,
  QUEUE_PATH,
  appendEvent,
  nextTaskId,
  nowIso,
  parseArgs,
  ensureOpsDir
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const title = args._.join(' ').trim();

if (!title) {
  console.error('Usage: npm run longrun:enqueue -- "Task title" --acceptance "..." --prompt "..." [--milestone M1] [--priority P1]');
  process.exit(1);
}

ensureOpsDir();
const state = requireState();
const queue = readJsonl(QUEUE_PATH);
const task = {
  id: nextTaskId(queue),
  title,
  milestone: args.milestone || state.milestone || 'M1',
  priority: args.priority || 'P2',
  acceptance: args.acceptance || '',
  prompt: args.prompt || '',
  notes: args.notes || '',
  status: 'PENDING',
  metrics: {
    stepCount: 0,
    totalDurationMs: 0,
    totalTokensUsed: 0,
    byHook: {}
  },
  createdAt: nowIso(),
  startedAt: null,
  completedAt: null,
  lastUpdated: nowIso()
};

queue.push(task);
writeJsonl(QUEUE_PATH, queue);
appendEvent('task_enqueued', {
  taskId: task.id,
  title: task.title,
  milestone: task.milestone,
  priority: task.priority
});

console.log(`enqueued ${task.id} ${task.title}`);
