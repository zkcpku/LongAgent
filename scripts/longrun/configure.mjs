#!/usr/bin/env node
import {
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_CHECKPOINT_HOOK,
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
  resolvePathInput
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
let state = requireState();

const nextHooks = {
  ...state.hooks
};
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'planning')) {
  nextHooks.planning = DEFAULT_PLANNING_HOOK;
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'repair')) {
  nextHooks.repair = DEFAULT_REPAIR_HOOK;
}
if (!Object.prototype.hasOwnProperty.call(nextHooks, 'checkpoint')) {
  nextHooks.checkpoint = DEFAULT_CHECKPOINT_HOOK;
}

for (const hookName of ['planning', 'implement', 'verify', 'repair', 'visualize', 'checkpoint']) {
  if (hookName in args) {
    nextHooks[hookName] = String(args[hookName]);
  }
}

if (args.clear) {
  for (const hookName of ['planning', 'implement', 'verify', 'repair', 'visualize', 'checkpoint']) {
    nextHooks[hookName] = '';
  }
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
  hooks: nextHooks
});

writeJson(STATE_PATH, state);
appendEvent('hooks_configured', {
  milestone: state.milestone,
  workdir: state.workdir,
  artifactsDir: state.artifactsDir,
  hasPlanning: Boolean(nextHooks.planning),
  hasImplement: Boolean(nextHooks.implement),
  hasVerify: Boolean(nextHooks.verify),
  hasRepair: Boolean(nextHooks.repair),
  hasVisualize: Boolean(nextHooks.visualize),
  hasCheckpoint: Boolean(nextHooks.checkpoint),
  repairMaxAttempts: state.repairMaxAttempts
});

console.log('hooks updated');
console.log(JSON.stringify(state.hooks, null, 2));
