#!/usr/bin/env node
import {
  requireState,
  readJsonl,
  QUEUE_PATH,
  EVENTS_PATH,
  countByStatus,
  getCurrentTask,
  parseArgs
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const asJson = Boolean(args.json);

const state = requireState();
const queue = readJsonl(QUEUE_PATH);
const events = readJsonl(EVENTS_PATH);
const counts = countByStatus(queue);
const current = getCurrentTask(queue, state);
const pending = queue.filter((task) => task.status === 'PENDING').slice(0, 5);
const recentEvents = events.slice(-8);

if (asJson) {
  console.log(JSON.stringify({
    state,
    counts,
    currentTask: current,
    nextPending: pending,
    recentEvents
  }, null, 2));
  process.exit(0);
}

console.log(`phase: ${state.phase}`);
console.log(`current: ${current ? `${current.id} ${current.title}` : 'none'}`);
if (current && Number.isFinite(Number(current.repairAttempts)) && Number(current.repairAttempts) > 0) {
  console.log(`repairAttempts: ${current.repairAttempts}/${state.repairMaxAttempts || 3}`);
}
if (current?.metrics) {
  const stepCount = Number(current.metrics.stepCount) || 0;
  const totalDurationMs = Number(current.metrics.totalDurationMs) || 0;
  const totalTokensUsed = Number(current.metrics.totalTokensUsed) || 0;
  console.log(`taskSteps: ${stepCount}`);
  console.log(`taskDurationMs: ${totalDurationMs}`);
  console.log(`taskTokensUsed: ${totalTokensUsed}`);
}
console.log(`workdir: ${state.workdir || process.cwd()}`);
console.log(`artifactsDir: ${state.artifactsDir || 'not set'}`);
console.log(`queue: pending=${counts.PENDING || 0} in_progress=${counts.IN_PROGRESS || 0} completed=${counts.COMPLETED || 0} blocked=${counts.BLOCKED || 0}`);
if (state.blockedReason) {
  console.log(`blockedReason: ${state.blockedReason}`);
}
console.log('');
console.log('next pending:');
if (pending.length === 0) {
  console.log('- none');
} else {
  for (const task of pending) {
    console.log(`- ${task.id} [${task.priority}] ${task.title}`);
  }
}

console.log('');
console.log('recent events:');
if (recentEvents.length === 0) {
  console.log('- none');
} else {
  for (const event of recentEvents) {
    const label = event.taskId ? ` (${event.taskId})` : '';
    console.log(`- ${event.at} ${event.type}${label}`);
  }
}
