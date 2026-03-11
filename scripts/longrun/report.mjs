#!/usr/bin/env node
import {
  requireState,
  readJsonl,
  QUEUE_PATH,
  EVENTS_PATH,
  parseArgs,
  parseTimeInput
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const now = new Date();

let since;
let until;

try {
  since = parseTimeInput(args.since || '24h', now);
  until = parseTimeInput(args.until || 'now', now);
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}

if (since > until) {
  console.error('Invalid range: since is after until');
  process.exit(1);
}

const state = requireState();
const queue = readJsonl(QUEUE_PATH);
const events = readJsonl(EVENTS_PATH);

const inRange = (iso) => {
  if (!iso) return false;
  const time = new Date(iso);
  return time >= since && time <= until;
};

const completedInRange = queue.filter((task) => task.status === 'COMPLETED' && inRange(task.completedAt));
const startedInRange = queue.filter((task) => inRange(task.startedAt));
const touchedInRange = queue.filter((task) => inRange(task.lastUpdated));
const currentTasks = queue.filter((task) => task.status === 'IN_PROGRESS');
const blockedTasks = queue.filter((task) => task.status === 'BLOCKED');
const eventsInRange = events.filter((event) => inRange(event.at));
const transitions = eventsInRange.filter((event) => event.type === 'phase_transition');
const hookSteps = eventsInRange.filter((event) => event.type === 'hook_executed');
const planningEvents = eventsInRange.filter((event) => event.type === 'planning_evaluated');
const verifyFailures = eventsInRange.filter((event) => event.type === 'verify_failed');
const repairs = eventsInRange.filter((event) => event.type === 'repair_succeeded');
const durationInRangeMs = hookSteps.reduce((acc, event) => acc + (Number(event.durationMs) || 0), 0);
const tokensInRange = hookSteps.reduce((acc, event) => acc + (Number(event.tokensUsed) || 0), 0);

console.log(`range: ${since.toISOString()} -> ${until.toISOString()}`);
console.log(`current phase: ${state.phase}`);
console.log(`current task id: ${state.currentTaskId || 'none'}`);
console.log(`workdir: ${state.workdir || process.cwd()}`);
console.log(`artifactsDir: ${state.artifactsDir || 'not set'}`);
console.log('');

console.log(`completed in range: ${completedInRange.length}`);
for (const task of completedInRange) {
  console.log(`- ${task.completedAt} ${task.id} ${task.title}`);
}
if (completedInRange.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`started in range: ${startedInRange.length}`);
for (const task of startedInRange) {
  console.log(`- ${task.startedAt} ${task.id} ${task.title} [${task.status}]`);
}
if (startedInRange.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`currently in progress: ${currentTasks.length}`);
for (const task of currentTasks) {
  const stepCount = Number(task.metrics?.stepCount) || 0;
  const totalDurationMs = Number(task.metrics?.totalDurationMs) || 0;
  const totalTokensUsed = Number(task.metrics?.totalTokensUsed) || 0;
  console.log(`- ${task.id} ${task.title} (started ${task.startedAt || 'n/a'}, steps=${stepCount}, durationMs=${totalDurationMs}, tokens=${totalTokensUsed})`);
}
if (currentTasks.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`blocked tasks: ${blockedTasks.length}`);
for (const task of blockedTasks) {
  console.log(`- ${task.id} ${task.title}`);
}
if (blockedTasks.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`phase transitions in range: ${transitions.length}`);
for (const event of transitions) {
  console.log(`- ${event.at} ${event.from} -> ${event.to}${event.taskId ? ` (${event.taskId})` : ''}`);
}
if (transitions.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`hook steps in range: ${hookSteps.length} (durationMs=${durationInRangeMs}, tokens=${tokensInRange})`);
if (hookSteps.length === 0) {
  console.log('- none');
} else {
  for (const event of hookSteps.slice(-30)) {
    console.log(`- ${event.at} ${event.taskId || 'n/a'} ${event.phase || ''}/${event.hook || ''} durationMs=${Number(event.durationMs) || 0} tokens=${Number(event.tokensUsed) || 0} cumulativeDurationMs=${Number(event.cumulativeDurationMs) || 0} cumulativeTokens=${Number(event.cumulativeTokensUsed) || 0}`);
  }
}

console.log('');
console.log(`planning evaluations in range: ${planningEvents.length}`);
for (const event of planningEvents) {
  console.log(`- ${event.at} ${event.taskId || 'n/a'} queueChanged=${Boolean(event.queueChanged)} planChanged=${Boolean(event.planChanged)} ok=${Boolean(event.ok)}`);
}
if (planningEvents.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`verify failures in range: ${verifyFailures.length}`);
for (const event of verifyFailures) {
  console.log(`- ${event.at} ${event.taskId || 'n/a'} attempt ${event.attempt || '?'} / ${event.maxAttempts || '?'}`);
}
if (verifyFailures.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`repairs succeeded in range: ${repairs.length}`);
for (const event of repairs) {
  console.log(`- ${event.at} ${event.taskId || 'n/a'} attempt ${event.attempt || '?'} / ${event.maxAttempts || '?'}`);
}
if (repairs.length === 0) {
  console.log('- none');
}

console.log('');
console.log(`all events in range: ${eventsInRange.length}`);
if (eventsInRange.length === 0) {
  console.log('- none');
} else {
  for (const event of eventsInRange.slice(-20)) {
    console.log(`- ${event.at} ${event.type}${event.taskId ? ` (${event.taskId})` : ''}`);
  }
}

console.log('');
console.log(`tasks touched in range: ${touchedInRange.length}`);
if (touchedInRange.length === 0) {
  console.log('- none');
} else {
  for (const task of touchedInRange) {
    console.log(`- ${task.id} ${task.title} [${task.status}]`);
  }
}
