#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  STATE_PATH,
  readJson,
  parseArgs
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const intervalSec = Number(args.interval || 15);
const hasMax = Object.prototype.hasOwnProperty.call(args, 'max');
const maxIterations = hasMax ? Number(args.max) : Infinity;

if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
  console.error('Invalid --interval value');
  process.exit(1);
}

if (hasMax) {
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    console.error('Invalid --max value');
    process.exit(1);
  }
}

const runOncePath = path.join(process.cwd(), 'scripts/longrun/run-once.mjs');
let iteration = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  while (iteration < maxIterations) {
    iteration += 1;
    console.log(`\n[longrun] iteration ${iteration}`);

    try {
      execFileSync(process.execPath, [runOncePath], { stdio: 'inherit' });
    } catch (error) {
      const state = readJson(STATE_PATH);
      if (state?.phase === 'BLOCKED') {
        console.log('[longrun] stopped: BLOCKED');
        process.exit(2);
      }
      console.error('[longrun] run-once failed');
      throw error;
    }

    const state = readJson(STATE_PATH);
    if (!state) {
      console.error('[longrun] missing state file after run');
      process.exit(1);
    }

    if (state.phase === 'DONE') {
      console.log('[longrun] stopped: DONE');
      process.exit(0);
    }

    if (state.phase === 'BLOCKED') {
      console.log('[longrun] stopped: BLOCKED');
      process.exit(2);
    }

    await sleep(intervalSec * 1000);
  }

  console.log(`[longrun] reached --max=${maxIterations}, exit`);
}

loop().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
