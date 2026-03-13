#!/usr/bin/env node
import {
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_CHECKPOINT_HOOK,
  DEFAULT_INIT_PLANNING_HOOK,
  DEFAULT_PLANNING_HOOK,
  DEFAULT_REPAIR_HOOK,
  DEFAULT_REPAIR_MAX_ATTEMPTS,
  ROOT,
  requireState,
  writeJson,
  STATE_PATH,
  parseArgs,
  appendEvent,
  updateState,
  ensureDir,
  ensureDirExists,
  resolvePathInput,
  normalizeGates,
  parseListArg
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (args['init-planning'] != null && args.initPlanning == null) {
  args.initPlanning = args['init-planning'];
}
let state = requireState();

function normalizeHookValue(input) {
  if (input == null || input === true) return '';
  const text = String(input);
  const lowered = text.trim().toLowerCase();
  if (lowered === 'off' || lowered === 'none' || lowered === 'false') {
    return '';
  }
  return text;
}

const nextHooks = {
  ...state.hooks
};
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'initPlanning')) {
  nextHooks.initPlanning = DEFAULT_INIT_PLANNING_HOOK;
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'planning')) {
  nextHooks.planning = DEFAULT_PLANNING_HOOK;
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'repair')) {
  nextHooks.repair = DEFAULT_REPAIR_HOOK;
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'checkpoint')) {
  nextHooks.checkpoint = DEFAULT_CHECKPOINT_HOOK;
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'acceptance')) {
  nextHooks.acceptance = '';
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'globalAcceptance')) {
  nextHooks.globalAcceptance = '';
}

for (const hookName of [
  'initPlanning',
  'planning',
  'implement',
  'verify',
  'acceptance',
  'repair',
  'visualize',
  'checkpoint',
  'globalAcceptance'
]) {
  if (hookName in args) {
    nextHooks[hookName] = normalizeHookValue(args[hookName]);
  }
}

if (args.clear) {
  for (const hookName of [
    'initPlanning',
    'planning',
    'implement',
    'verify',
    'acceptance',
    'repair',
    'visualize',
    'checkpoint',
    'globalAcceptance'
  ]) {
    nextHooks[hookName] = '';
  }
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

const globalGateArgsPresent = [
  'global-acceptance-cmd',
  'global-required-files',
  'global-forbid-patterns',
  'global-required-test-packages',
  'global-min-test-files',
  'global-min-test-cases',
  'global-fail-on-no-tests'
].some((key) => key in args);

let nextGlobalGates = normalizeGates(state.globalGates);
if (globalGateArgsPresent) {
  nextGlobalGates = normalizeGates({
    ...nextGlobalGates,
    cmd: args['global-acceptance-cmd'] != null
      ? String(args['global-acceptance-cmd'])
      : nextGlobalGates.cmd,
    requiredFiles: args['global-required-files'] != null
      ? parseListArg(args['global-required-files'])
      : nextGlobalGates.requiredFiles,
    forbidPatterns: args['global-forbid-patterns'] != null
      ? parseListArg(args['global-forbid-patterns'])
      : nextGlobalGates.forbidPatterns,
    requiredTestPackages: args['global-required-test-packages'] != null
      ? parseListArg(args['global-required-test-packages'])
      : nextGlobalGates.requiredTestPackages,
    minTestFiles: args['global-min-test-files'] != null
      ? parsePositiveInt(args['global-min-test-files'])
      : nextGlobalGates.minTestFiles,
    minTestCases: args['global-min-test-cases'] != null
      ? parsePositiveInt(args['global-min-test-cases'])
      : nextGlobalGates.minTestCases,
    failOnNoTests: args['global-fail-on-no-tests'] != null
      ? parseBooleanArg(args['global-fail-on-no-tests'], nextGlobalGates.failOnNoTests)
      : nextGlobalGates.failOnNoTests
  });
}

if (args.milestone) {
  state = updateState(state, {
    milestone: String(args.milestone)
  });
}

if (args.workdir) {
  const workdir = resolvePathInput(args.workdir);
  ensureDirExists(workdir, 'workdir');
  state = updateState(state, { workdir });
}

if (args['artifacts-dir']) {
  const artifactsDir = resolvePathInput(args['artifacts-dir']);
  ensureDir(artifactsDir);
  state = updateState(state, { artifactsDir });
}

if (args['repair-max-attempts']) {
  const parsed = Number(args['repair-max-attempts']);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Invalid --repair-max-attempts value, expected positive number.');
  }
  state = updateState(state, { repairMaxAttempts: Math.floor(parsed) });
}

if (args['reset-init-planning'] != null) {
  const shouldReset = parseBooleanArg(args['reset-init-planning'], true);
  if (shouldReset) {
    state = updateState(state, { initPlanningDone: false });
  }
}

if (!state.workdir) {
  state = updateState(state, { workdir: ROOT });
}

if (!state.artifactsDir) {
  const artifactsDir = DEFAULT_ARTIFACTS_DIR;
  ensureDir(artifactsDir);
  state = updateState(state, { artifactsDir });
}

if (!state.repairMaxAttempts || Number(state.repairMaxAttempts) <= 0) {
  state = updateState(state, { repairMaxAttempts: DEFAULT_REPAIR_MAX_ATTEMPTS });
}

state = updateState(state, {
  hooks: nextHooks,
  globalGates: nextGlobalGates
});

writeJson(STATE_PATH, state);
appendEvent('hooks_configured', {
  milestone: state.milestone,
  workdir: state.workdir,
  artifactsDir: state.artifactsDir,
  hasPlanning: Boolean(nextHooks.planning),
  hasInitPlanning: Boolean(nextHooks.initPlanning),
  hasImplement: Boolean(nextHooks.implement),
  hasVerify: Boolean(nextHooks.verify),
  hasAcceptance: Boolean(nextHooks.acceptance),
  hasRepair: Boolean(nextHooks.repair),
  hasVisualize: Boolean(nextHooks.visualize),
  hasCheckpoint: Boolean(nextHooks.checkpoint),
  hasGlobalAcceptance: Boolean(nextHooks.globalAcceptance),
  hasGlobalGates:
    Boolean(nextGlobalGates.cmd) ||
    nextGlobalGates.requiredFiles.length > 0 ||
    nextGlobalGates.forbidPatterns.length > 0 ||
    nextGlobalGates.requiredTestPackages.length > 0 ||
    nextGlobalGates.minTestFiles > 0 ||
    nextGlobalGates.minTestCases > 0 ||
    nextGlobalGates.failOnNoTests,
  repairMaxAttempts: state.repairMaxAttempts
});

console.log('hooks updated');
console.log(JSON.stringify(state.hooks, null, 2));
