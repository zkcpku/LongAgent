#!/usr/bin/env node
import {
  PHASES,
  requireState,
  readJsonl,
  writeJson,
  writeJsonl,
  STATE_PATH,
  QUEUE_PATH,
  appendEvent,
  parseArgs,
  setTask,
  writeSnapshot,
  updateState
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));

let state = requireState();
let queue = readJsonl(QUEUE_PATH);

let targetPhase = 'PLANNING';
if (args.phase) {
  const phase = String(args.phase).toUpperCase();
  if (!PHASES.includes(phase)) {
    console.error(`Invalid --phase value: ${args.phase}`);
    process.exit(1);
  }
  if (phase === 'BLOCKED') {
    console.error('Invalid --phase value: BLOCKED');
    process.exit(1);
  }
  targetPhase = phase;
}

if (state.phase !== 'BLOCKED' && !args.force) {
  console.log('state is not BLOCKED. Pass --force to reset phase anyway.');
  process.exit(0);
}

const taskId = args.task || state.currentTaskId;
if (taskId && args['to-pending']) {
  queue = setTask(queue, taskId, { status: 'PENDING' });
}
if (taskId && args['to-in-progress']) {
  queue = setTask(queue, taskId, { status: 'IN_PROGRESS' });
}

state = updateState(state, {
  phase: targetPhase,
  blockedReason: null
});

writeJson(STATE_PATH, state);
writeJsonl(QUEUE_PATH, queue);
writeSnapshot(state, queue);
appendEvent('unblocked', {
  taskId: taskId || null,
  phase: targetPhase,
  toPending: Boolean(args['to-pending']),
  toInProgress: Boolean(args['to-in-progress'])
});

console.log(`state reset to ${targetPhase}`);
