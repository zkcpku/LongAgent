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
  ensureOpsDir,
  normalizeGates,
  parseListArg
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const title = args._.join(' ').trim();

if (!title) {
  console.error('Usage: npm run longrun:enqueue -- "Task title" --acceptance "..." --prompt "..." [--milestone M1] [--priority P1] [--acceptance-cmd "..."]');
  process.exit(1);
}

function parseBooleanArg(input, fallback = false) {
  if (input == null) return fallback;
  if (input === true) return true;
  const text = String(input).trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function parsePositiveInt(input) {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function parseTaskGates(cliArgs) {
  const raw = {
    cmd: cliArgs['acceptance-cmd'] ? String(cliArgs['acceptance-cmd']) : '',
    requiredFiles: parseListArg(cliArgs['required-files']),
    forbidPatterns: parseListArg(cliArgs['forbid-patterns']),
    requiredTestPackages: parseListArg(cliArgs['required-test-packages']),
    minTestFiles: parsePositiveInt(cliArgs['min-test-files']),
    minTestCases: parsePositiveInt(cliArgs['min-test-cases']),
    failOnNoTests: parseBooleanArg(cliArgs['fail-on-no-tests'], false)
  };
  const gates = normalizeGates(raw);
  const hasAny =
    Boolean(gates.cmd) ||
    gates.requiredFiles.length > 0 ||
    gates.forbidPatterns.length > 0 ||
    gates.requiredTestPackages.length > 0 ||
    gates.minTestFiles > 0 ||
    gates.minTestCases > 0 ||
    gates.failOnNoTests;
  return hasAny ? gates : null;
}

ensureOpsDir();
const state = requireState();
const queue = readJsonl(QUEUE_PATH);
const taskGates = parseTaskGates(args);
const task = {
  id: nextTaskId(queue),
  title,
  milestone: args.milestone || state.milestone || 'M1',
  priority: args.priority || 'P2',
  acceptance: args.acceptance || '',
  prompt: args.prompt || '',
  notes: args.notes || '',
  gates: taskGates || undefined,
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
