import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROOT = process.cwd();
export const OPS_DIR = path.join(ROOT, 'ops');
export const STATE_PATH = path.join(OPS_DIR, 'state.json');
export const QUEUE_PATH = path.join(OPS_DIR, 'queue.jsonl');
export const EVENTS_PATH = path.join(OPS_DIR, 'events.jsonl');
export const LOCK_PATH = path.join(OPS_DIR, '.runner.lock');
export const DEFAULT_ARTIFACTS_DIR = path.join(ROOT, 'artifacts', 'longrun');

export const PHASES = [
  'PLANNING',
  'IMPLEMENTING',
  'VERIFYING',
  'REPAIRING',
  'VISUALIZING',
  'CHECKPOINT',
  'BLOCKED',
  'DONE'
];

export const DEFAULT_REPAIR_MAX_ATTEMPTS = 3;
export const DEFAULT_INIT_PLANNING_HOOK = '';
export const DEFAULT_REPAIR_HOOK = `set -e
PROMPT_FILE="{{task_artifacts_dir}}/repair.prompt.txt"
ACCEPTANCE_FAILURES=""
if [ -f "{{acceptance_failures_path}}" ]; then
  ACCEPTANCE_FAILURES="$(cat "{{acceptance_failures_path}}")"
fi
cat > "$PROMPT_FILE" <<__LR_REPAIR_PROMPT__
Verify/acceptance failed for task {{task_id}} ({{task_title}}).

Diagnose using these sources:
1. Verify log: {{task_artifacts_dir}}/verify.log
2. Acceptance gate failures (if any): {{acceptance_failures_path}}

\${ACCEPTANCE_FAILURES:+Acceptance gate failure details:
\$ACCEPTANCE_FAILURES
}
Fix the code in {{workdir}}. Respect acceptance: {{task_acceptance}}. Make the minimal fix and stop.
__LR_REPAIR_PROMPT__
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat "$PROMPT_FILE")" > "{{task_artifacts_dir}}/repair.log" 2>&1`;
export const DEFAULT_PLANNING_HOOK = `set -e
PROMPT_FILE="{{task_artifacts_dir}}/planning.prompt.txt"
cat > "$PROMPT_FILE" <<'__LR_PLANNING_PROMPT__'
You are managing a long-running migration task. Review current progress in {{workdir}}, then review {{plan_path}} and {{queue_path}}. Decide whether to update plan/queue. Rules: (1) keep completed/in-progress/blocked tasks untouched unless fixing obvious metadata mistakes, (2) add/split/reorder only pending tasks when needed, (3) keep queue JSONL schema unchanged, (4) avoid duplicate tasks, (5) if no changes are needed, do nothing. Current task: {{task_id}} {{task_title}}. Acceptance: {{task_acceptance}}.
__LR_PLANNING_PROMPT__
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat "$PROMPT_FILE")" > "{{task_artifacts_dir}}/planning.log" 2>&1`;
export const DEFAULT_CHECKPOINT_HOOK =
  'set -e; if [ -d .git ]; then if ! git config user.email >/dev/null 2>&1; then git config user.email "codex-longrun@local"; fi; if ! git config user.name >/dev/null 2>&1; then git config user.name "Codex Longrun"; fi; git add -A; if git diff --cached --quiet; then echo "[checkpoint] no changes to commit"; else SHORTSTAT="$(git diff --cached --shortstat | sed \'s/^ *//;s/ *$//\')"; FILES="$(git diff --cached --name-only | head -n 6 | tr \'\\n\' \',\' | sed \'s/,$//\')"; MSG="checkpoint({{task_id}}): {{task_title}}"; if [ -n "$SHORTSTAT" ]; then MSG="$MSG | $SHORTSTAT"; fi; if [ -n "$FILES" ]; then MSG="$MSG | files: $FILES"; fi; MSG="$(printf \'%s\' "$MSG" | cut -c1-240)"; git commit -m "$MSG"; fi; else echo "[checkpoint] skip commit: no git repo in {{workdir}}"; fi; echo "$(date -Iseconds) {{task_id}} {{task_title}}" >> "{{artifacts_dir}}/timeline.log"';

const EMPTY_GATES = Object.freeze({
  cmd: '',
  requiredFiles: [],
  forbidPatterns: [],
  requiredTestPackages: [],
  minTestFiles: 0,
  minTestCases: 0,
  failOnNoTests: false
});

export function nowIso() {
  return new Date().toISOString();
}

export function ensureOpsDir() {
  fs.mkdirSync(OPS_DIR, { recursive: true });
}

export function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function writeJsonl(filePath, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

export function appendJsonl(filePath, row) {
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(filePath, line, 'utf8');
}

export function appendEvent(type, data = {}) {
  const event = {
    at: nowIso(),
    type,
    ...data
  };
  appendJsonl(EVENTS_PATH, event);
  return event;
}

export function resolvePathInput(input, baseDir = ROOT) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(baseDir, raw);
}

export function ensureDirExists(dirPath, label = 'directory') {
  if (!dirPath) {
    throw new Error(`Missing ${label} path.`);
  }
  if (!fs.existsSync(dirPath)) {
    throw new Error(`${label} does not exist: ${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

export function ensureDir(dirPath) {
  if (!dirPath) {
    throw new Error('Missing directory path.');
  }
  fs.mkdirSync(dirPath, { recursive: true });
  ensureDirExists(dirPath, 'directory');
}

export function defaultState(options = {}) {
  const now = nowIso();
  const workdir = options.workdir || ROOT;
  const artifactsDir = options.artifactsDir || DEFAULT_ARTIFACTS_DIR;
  const repairMaxAttempts =
    Number.isFinite(Number(options.repairMaxAttempts)) && Number(options.repairMaxAttempts) > 0
      ? Number(options.repairMaxAttempts)
      : DEFAULT_REPAIR_MAX_ATTEMPTS;
  return {
    version: 1,
    phase: 'PLANNING',
    currentTaskId: null,
    blockedReason: null,
    initPlanningDone: false,
    milestone: 'M1',
    repairMaxAttempts,
    lastRunAt: null,
    workdir,
    artifactsDir,
    updatedAt: now,
    globalGates: {
      ...EMPTY_GATES
    },
    hooks: {
      initPlanning: DEFAULT_INIT_PLANNING_HOOK,
      planning: DEFAULT_PLANNING_HOOK,
      implement: '',
      verify: '',
      acceptance: '',
      repair: DEFAULT_REPAIR_HOOK,
      visualize: '',
      checkpoint: DEFAULT_CHECKPOINT_HOOK,
      globalAcceptance: ''
    }
  };
}

export function parseListArg(input) {
  if (input == null || input === false) return [];
  const text = String(input).trim();
  if (!text) return [];
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeGates(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      ...EMPTY_GATES
    };
  }

  const minTestFiles = Number(raw.minTestFiles);
  const minTestCases = Number(raw.minTestCases);

  return {
    cmd: typeof raw.cmd === 'string' ? raw.cmd.trim() : '',
    requiredFiles: Array.isArray(raw.requiredFiles)
      ? raw.requiredFiles.map((v) => String(v).trim()).filter(Boolean)
      : [],
    forbidPatterns: Array.isArray(raw.forbidPatterns)
      ? raw.forbidPatterns.map((v) => String(v).trim()).filter(Boolean)
      : [],
    requiredTestPackages: Array.isArray(raw.requiredTestPackages)
      ? raw.requiredTestPackages.map((v) => String(v).trim()).filter(Boolean)
      : [],
    minTestFiles: Number.isFinite(minTestFiles) && minTestFiles > 0 ? Math.floor(minTestFiles) : 0,
    minTestCases: Number.isFinite(minTestCases) && minTestCases > 0 ? Math.floor(minTestCases) : 0,
    failOnNoTests: Boolean(raw.failOnNoTests)
  };
}

export function nextTaskId(queue) {
  const maxNum = queue
    .map((task) => task.id)
    .filter((id) => /^T\d+$/.test(id || ''))
    .map((id) => Number(id.slice(1)))
    .reduce((acc, num) => Math.max(acc, num), 0);
  return `T${String(maxNum + 1).padStart(4, '0')}`;
}

export function getCurrentTask(queue, state) {
  if (state.currentTaskId) {
    return queue.find((task) => task.id === state.currentTaskId) || null;
  }
  return (
    queue.find((task) => task.status === 'IN_PROGRESS') ||
    queue.find((task) => task.status === 'PENDING') ||
    null
  );
}

export function countByStatus(queue) {
  return queue.reduce((acc, task) => {
    const key = task.status || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

export function parseTimeInput(value, now = new Date()) {
  if (!value) return null;

  if (value === 'now') return new Date(now);

  const relative = String(value).match(/^(\d+)([smhdw])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000
    };
    return new Date(now.getTime() - amount * multipliers[unit]);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return parsed;
}

function fillTemplate(input, context) {
  let output = input;
  const pairs = Object.entries(context);
  for (const [key, value] of pairs) {
    const safe = value == null ? '' : String(value);
    output = output.replaceAll(`{{${key}}}`, safe);
  }
  return output;
}

export function runHook(rawCommand, context, options = {}) {
  if (!rawCommand || !String(rawCommand).trim()) {
    return {
      ok: true,
      skipped: true,
      command: '',
      startedAt: nowIso(),
      endedAt: nowIso(),
      durationMs: 0
    };
  }

  const command = fillTemplate(String(rawCommand), context);
  const cwd = options.cwd || ROOT;
  const liveOutput = options.liveOutput !== false;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const proc = spawnSync(command, {
    cwd,
    shell: true,
    encoding: liveOutput ? undefined : 'utf8',
    stdio: liveOutput ? 'inherit' : 'pipe'
  });
  const endedAt = nowIso();
  const durationMs = Math.max(0, Date.now() - startedMs);

  return {
    ok: proc.status === 0,
    skipped: false,
    command,
    startedAt,
    endedAt,
    durationMs,
    exitCode: proc.status,
    stdout: typeof proc.stdout === 'string' ? proc.stdout : '',
    stderr: typeof proc.stderr === 'string' ? proc.stderr : ''
  };
}

export function acquireLock() {
  ensureOpsDir();
  const writeLock = () => {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, `${process.pid} ${nowIso()}\n`);
    return fd;
  };

  try {
    return writeLock();
  } catch (error) {
    if (!(error && error.code === 'EEXIST')) {
      throw error;
    }

    let lockIsStale = false;
    if (fs.existsSync(LOCK_PATH)) {
      const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim();
      const pidText = raw.split(/\s+/)[0];
      const pid = Number(pidText);
      if (!Number.isFinite(pid)) {
        lockIsStale = true;
      } else {
        try {
          process.kill(pid, 0);
          lockIsStale = false;
        } catch {
          lockIsStale = true;
        }
      }
    }

    if (lockIsStale) {
      fs.unlinkSync(LOCK_PATH);
      return writeLock();
    }

    throw new Error(`Runner lock exists at ${LOCK_PATH}. Another process may be running.`);
  }
}

export function releaseLock(fd) {
  try {
    if (typeof fd === 'number') {
      fs.closeSync(fd);
    }
  } finally {
    if (fs.existsSync(LOCK_PATH)) {
      fs.unlinkSync(LOCK_PATH);
    }
  }
}

export function requireState() {
  const state = readJson(STATE_PATH);
  if (!state) {
    throw new Error('Missing ops/state.json. Run `npm run longrun:init` first.');
  }
  return state;
}

export function updateState(state, patch) {
  const next = {
    ...state,
    ...patch,
    updatedAt: nowIso()
  };
  return next;
}

export function findTask(queue, taskId) {
  return queue.find((task) => task.id === taskId) || null;
}

export function setTask(queue, taskId, patch) {
  return queue.map((task) => {
    if (task.id !== taskId) return task;
    return {
      ...task,
      ...patch,
      lastUpdated: nowIso()
    };
  });
}

export function writeSnapshot(state, queue) {
  const counts = countByStatus(queue);
  const current = getCurrentTask(queue, state);
  const lines = [];
  lines.push(`# Long Running Status Snapshot`);
  lines.push('');
  lines.push(`- Updated: ${nowIso()}`);
  lines.push(`- Phase: ${state.phase}`);
  lines.push(`- Workdir: ${state.workdir || ROOT}`);
  lines.push(`- Artifacts Dir: ${state.artifactsDir || DEFAULT_ARTIFACTS_DIR}`);
  const globalGates = normalizeGates(state.globalGates);
  const hasGlobalGates =
    Boolean(globalGates.cmd) ||
    globalGates.requiredFiles.length > 0 ||
    globalGates.forbidPatterns.length > 0 ||
    globalGates.requiredTestPackages.length > 0 ||
    globalGates.minTestFiles > 0 ||
    globalGates.minTestCases > 0 ||
    globalGates.failOnNoTests;
  const hasGlobalHook = Boolean(String(state.hooks?.globalAcceptance || '').trim());
  lines.push(`- Global Gate Enabled: ${hasGlobalGates || hasGlobalHook}`);
  lines.push(`- Current Task: ${current ? `${current.id} ${current.title}` : 'None'}`);
  if (current && Number.isFinite(Number(current.repairAttempts)) && Number(current.repairAttempts) > 0) {
    lines.push(`- Current Repair Attempts: ${current.repairAttempts}/${state.repairMaxAttempts || DEFAULT_REPAIR_MAX_ATTEMPTS}`);
  }
  if (current?.metrics) {
    const totalDurationMs = Number(current.metrics.totalDurationMs) || 0;
    const totalTokensUsed = Number(current.metrics.totalTokensUsed) || 0;
    const stepCount = Number(current.metrics.stepCount) || 0;
    lines.push(`- Current Step Count: ${stepCount}`);
    lines.push(`- Current Total Duration Ms: ${totalDurationMs}`);
    lines.push(`- Current Total Tokens Used: ${totalTokensUsed}`);
  }
  lines.push(`- Queue: pending=${counts.PENDING || 0}, in_progress=${counts.IN_PROGRESS || 0}, completed=${counts.COMPLETED || 0}, blocked=${counts.BLOCKED || 0}`);
  if (state.blockedReason) {
    lines.push(`- Blocked Reason: ${state.blockedReason}`);
  }
  lines.push('');
  lines.push('## Next Tasks');
  lines.push('');
  const nextTasks = queue.filter((task) => task.status === 'PENDING').slice(0, 5);
  if (nextTasks.length === 0) {
    lines.push('- None');
  } else {
    for (const task of nextTasks) {
      lines.push(`- ${task.id} ${task.title}`);
    }
  }

  fs.writeFileSync(path.join(OPS_DIR, 'status.md'), `${lines.join('\n')}\n`, 'utf8');
}

export function printHookResult(name, result) {
  if (result.skipped) {
    console.log(`[${name}] skipped (hook not configured)`);
    return;
  }
  console.log(`[${name}] command: ${result.command}`);
  if (result.stdout.trim()) {
    console.log(`[${name}] stdout:\n${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    console.log(`[${name}] stderr:\n${result.stderr.trim()}`);
  }
  if (Number.isFinite(Number(result.durationMs))) {
    console.log(`[${name}] durationMs=${result.durationMs}`);
  }
  console.log(`[${name}] exitCode=${result.exitCode}`);
}
