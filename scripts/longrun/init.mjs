#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT,
  DEFAULT_ARTIFACTS_DIR,
  OPS_DIR,
  STATE_PATH,
  QUEUE_PATH,
  EVENTS_PATH,
  defaultState,
  writeJson,
  parseArgs,
  appendEvent,
  ensureOpsDir,
  ensureDir,
  ensureDirExists,
  resolvePathInput
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const force = Boolean(args.force);
const gitInitArg = args['git-init'];
const shouldGitInit = gitInitArg == null ? true : String(gitInitArg).toLowerCase() !== 'false';
const workdir = resolvePathInput(args.workdir || ROOT);
const artifactsDir = resolvePathInput(args['artifacts-dir'] || DEFAULT_ARTIFACTS_DIR);

ensureDirExists(workdir, 'workdir');
ensureDir(artifactsDir);

function ensureGitRepo(repoDir) {
  const gitDir = path.join(repoDir, '.git');
  if (fs.existsSync(gitDir)) {
    console.log(`skip git init (${path.relative(process.cwd(), repoDir)} already has .git)`);
    return false;
  }
  const init = spawnSync('git', ['init'], {
    cwd: repoDir,
    encoding: 'utf8'
  });
  if (init.status !== 0) {
    const err = (init.stderr || init.stdout || '').trim();
    throw new Error(`git init failed in ${repoDir}${err ? `: ${err}` : ''}`);
  }
  console.log(`git init ${path.relative(process.cwd(), repoDir)}`);
  return true;
}

const templates = {
  'Prompt.md': `# Prompt\n\n## Objective\n- Fill in the long-running mission in one sentence.\n\n## Constraints\n- Keep commits small and reversible.\n- Always run verification before moving to next task.\n\n## Definition Of Done\n- Milestone goals are complete.\n- Required visual artifacts are generated and linked.\n`,
  'Plan.md': `# Plan\n\n## Milestones\n1. M1\n2. M2\n\n## Task Breakdown\n- [ ] Create task list in ops/queue.jsonl via 'npm run longrun:enqueue -- \"Task title\" --acceptance \"...\" --prompt \"...\"'.\n\n## Acceptance\n- Each task has explicit acceptance criteria.\n- Each milestone has at least one visual checkpoint.\n`,
  'Implement.md': `# Implement Rules\n\n## Execution Order\n1. PLANNING\n2. IMPLEMENTING\n3. VERIFYING\n4. ACCEPTANCE (task gates + optional acceptance hook)\n5. REPAIRING (if verify/acceptance fails)\n6. VISUALIZING\n7. CHECKPOINT\n\n## Planning Behavior\n- In PLANNING, review current workspace progress and adjust ops/Plan.md + ops/queue.jsonl when needed.\n- Prefer minimal queue edits (split, reorder, add) and avoid touching completed tasks.\n\n## Checkpoint Behavior\n- CHECKPOINT should append timeline and create a git commit when there are staged changes.\n- Default commit message is auto-generated from task metadata + staged diff summary.\n\n## Required Checks\n- lint\n- typecheck\n- tests\n- build\n\n## Completion Behavior\n- A task is complete only when verify + acceptance gates pass.\n- Queue empty enters DONE only after global acceptance gate (if configured) passes.\n\n## Visual Deliverables\n- Milestone start: generate-visual-plan\n- Task complete: diff-review\n- Milestone midpoint: plan-review\n- Milestone end: project-recap + slides\n`,
  'Documentation.md': `# Documentation Log\n\n## Usage\n- Append one entry after each CHECKPOINT.\n\n## Entries\n\n### YYYY-MM-DD HH:mm\n- Task: T0001\n- What was done:\n- What is in progress:\n- Risks / blockers:\n- Artifact links:\n`
};

function writeFileIfNeeded(filePath, content) {
  if (fs.existsSync(filePath) && !force) {
    console.log(`skip ${path.relative(process.cwd(), filePath)} (exists)`);
    return;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`write ${path.relative(process.cwd(), filePath)}`);
}

ensureOpsDir();

for (const [name, content] of Object.entries(templates)) {
  writeFileIfNeeded(path.join(OPS_DIR, name), content);
}

if (!fs.existsSync(QUEUE_PATH) || force) {
  fs.writeFileSync(QUEUE_PATH, '', 'utf8');
  console.log(`write ${path.relative(process.cwd(), QUEUE_PATH)}`);
}

if (!fs.existsSync(EVENTS_PATH) || force) {
  fs.writeFileSync(EVENTS_PATH, '', 'utf8');
  console.log(`write ${path.relative(process.cwd(), EVENTS_PATH)}`);
}

if (!fs.existsSync(STATE_PATH) || force) {
  writeJson(STATE_PATH, defaultState({ workdir, artifactsDir }));
  console.log(`write ${path.relative(process.cwd(), STATE_PATH)}`);
} else {
  console.log(`skip ${path.relative(process.cwd(), STATE_PATH)} (exists)`);
}

let gitInitialized = false;
if (shouldGitInit) {
  gitInitialized = ensureGitRepo(workdir);
}

appendEvent('initialized', {
  force,
  workdir,
  artifactsDir,
  gitInit: shouldGitInit,
  gitInitialized
});
console.log('longrun initialized');
