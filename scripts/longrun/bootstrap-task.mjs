#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, OPS_DIR, QUEUE_PATH, parseArgs, resolvePathInput } from './lib.mjs';

function parseBooleanArg(input, fallback = false) {
  if (input == null) return fallback;
  if (input === true) return true;
  const text = String(input).trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function parsePositiveInt(input, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parseOptionalPositiveInt(input) {
  if (input == null || input === true) return null;
  const text = String(input).trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid --max-tasks value, expected a positive number.');
  }
  return Math.floor(value);
}

function normalizePriority(value) {
  const text = String(value || '').toUpperCase().trim();
  if (text === 'P0' || text === 'P1' || text === 'P2') return text;
  return 'P1';
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (value == null) return [];
  return String(value)
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function inferMilestone(index, total) {
  const denom = Math.max(total, 1);
  const ratio = (index + 1) / denom;
  if (ratio <= 0.25) return 'M1';
  if (ratio <= 0.5) return 'M2';
  if (ratio <= 0.75) return 'M3';
  return 'M4';
}

function runNodeScript(scriptName, scriptArgs) {
  const scriptPath = path.join(ROOT, 'scripts', 'longrun', scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`Failed: ${scriptName} ${scriptArgs.join(' ')}`);
  }
}

function ensureOpsFile(fileName, content) {
  fs.mkdirSync(OPS_DIR, { recursive: true });
  fs.writeFileSync(path.join(OPS_DIR, fileName), content, 'utf8');
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function streamWithPrefix(readable, prefix, onRawChunk) {
  let pending = '';
  readable.on('data', (chunk) => {
    const text = chunk.toString();
    onRawChunk(text);
    const merged = pending + text;
    const parts = merged.split(/\r?\n/);
    pending = parts.pop() || '';
    for (const line of parts) process.stdout.write(`${prefix}${line}\n`);
  });
  readable.on('end', () => {
    if (pending) process.stdout.write(`${prefix}${pending}\n`);
  });
}

function startRunner(intervalSec) {
  const logPath = path.join(OPS_DIR, 'longrun-daemon.log');
  const pidPath = path.join(OPS_DIR, 'longrun-daemon.pid');
  const outFd = fs.openSync(logPath, 'a');
  const child = spawn('npm', ['run', 'longrun:run', '--', '--interval', String(intervalSec)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', outFd, outFd]
  });
  child.unref();
  fs.writeFileSync(pidPath, `${child.pid}\n`, 'utf8');
  fs.closeSync(outFd);
  return child.pid;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Continue with robust parsing.
  }

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue.
    }
  }

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeTask(rawTask, index, total) {
  const requiredFiles = unique(toStringList(rawTask?.requiredFiles));
  const forbidPatterns = unique(toStringList(rawTask?.forbidPatterns));
  const requiredTestPackages = unique(toStringList(rawTask?.requiredTestPackages));
  const minTestFiles = parsePositiveInt(rawTask?.minTestFiles, 0);
  const minTestCases = parsePositiveInt(rawTask?.minTestCases, 0);
  const failOnNoTests = Boolean(rawTask?.failOnNoTests);
  const title = String(rawTask?.title || `Task ${index + 1}`).trim();

  return {
    title,
    milestone: String(rawTask?.milestone || inferMilestone(index, total)).trim() || inferMilestone(index, total),
    priority: normalizePriority(rawTask?.priority),
    acceptance: String(rawTask?.acceptance || '').trim() || `Complete ${title}`,
    prompt: String(rawTask?.prompt || '').trim() || String(rawTask?.acceptance || '').trim() || `Complete ${title}`,
    requiredFiles,
    acceptanceCmd: String(rawTask?.acceptanceCmd || '').trim(),
    forbidPatterns,
    requiredTestPackages,
    minTestFiles,
    minTestCases,
    failOnNoTests
  };
}

function runCodexDecomposition(requirement, objective, maxTasks, plannerLogPath) {
  const prompt = [
    'You are the INIT_PLANNING planner for a long-running autonomous engineering agent.',
    `Objective: ${objective}`,
    '',
    'Requirement:',
    requirement,
    '',
    'Planning rules:',
    '- Produce a concrete queue that an automated coding agent can execute sequentially without human interpretation.',
    '- Avoid vague tasks (no "improve quality", "implement core features"). Each task must target specific deliverables.',
    '- Prefer milestone progression: M1 foundation, M2 core implementation, M3 integration/verification, M4 hardening/release.',
    '- Include acceptance and prompt with operational detail and machine-checkable checks whenever practical.',
    '- Use requiredFiles/acceptanceCmd/forbidPatterns/requiredTestPackages/minTestFiles/minTestCases/failOnNoTests when applicable.',
    maxTasks
      ? `- Output at most ${maxTasks} tasks.`
      : '- No hard task-count cap. Produce the full queue needed for complete, executable delivery.',
    '',
    'Few-shot example',
    'Example requirement:',
    'Build a production-grade, full-featured C compiler in Rust with full frontend, native x86_64 ELF backend, ARM64/RISC-V path, robust driver, conformance tests, and performance goals.',
    'Example output JSON:',
    '{',
    '  "summary": "A staged production plan for a Rust C compiler from architecture through frontend/backend, validation, and hardening.",',
    '  "milestones": [',
    '    {"id":"M1","title":"Architecture and foundation"},',
    '    {"id":"M2","title":"Frontend completeness"},',
    '    {"id":"M3","title":"Backend and driver maturity"},',
    '    {"id":"M4","title":"Conformance and hardening"}',
    '  ],',
    '  "tasks": [',
    '    {',
    '      "title":"Create compiler workspace and architecture contracts",',
    '      "milestone":"M1",',
    '      "priority":"P0",',
    '      "acceptance":"Workspace crates and architecture docs exist and build.",',
    '      "prompt":"Create crate layout for frontend/ir/passes/backend/common/driver, define interfaces, and ensure workspace compiles.",',
    '      "requiredFiles":["Cargo.toml","docs/architecture.md","frontend","ir","backend","driver"],',
    '      "acceptanceCmd":"cargo check --workspace",',
    '      "forbidPatterns":[],"requiredTestPackages":[],"minTestFiles":0,"minTestCases":0,"failOnNoTests":false',
    '    },',
    '    {',
    '      "title":"Implement lexer and preprocessor core",',
    '      "milestone":"M2",',
    '      "priority":"P0",',
    '      "acceptance":"Lexer and preprocessor handle core C tokenization and macro/include semantics with tests.",',
    '      "prompt":"Implement C lexer coverage plus preprocessor include/macro/conditional behavior with diagnostics and tests.",',
    '      "requiredFiles":["frontend/src/lexer.rs","frontend/src/preprocessor.rs"],',
    '      "acceptanceCmd":"cargo test --workspace",',
    '      "forbidPatterns":[],"requiredTestPackages":["frontend"],"minTestFiles":2,"minTestCases":20,"failOnNoTests":true',
    '    },',
    '    {',
    '      "title":"Implement parser and semantic analysis pipeline",',
    '      "milestone":"M2",',
    '      "priority":"P0",',
    '      "acceptance":"Parser and sema process major C constructs and diagnostics are validated by tests.",',
    '      "prompt":"Implement parser + sema for declarations/statements/expressions/type checking and regression tests.",',
    '      "requiredFiles":["frontend/src/parser.rs","frontend/src/sema.rs"],',
    '      "acceptanceCmd":"cargo test --workspace",',
    '      "forbidPatterns":[],"requiredTestPackages":["frontend"],"minTestFiles":2,"minTestCases":20,"failOnNoTests":true',
    '    },',
    '    {',
    '      "title":"Deliver x86_64 backend and native ELF emission",',
    '      "milestone":"M3",',
    '      "priority":"P0",',
    '      "acceptance":"x86_64 codegen and ELF object emission produce runnable outputs for smoke programs.",',
    '      "prompt":"Implement x86_64 backend with ABI/frame/codegen plus ELF writer and smoke tests.",',
    '      "requiredFiles":["backend/x86_64/src/lib.rs","backend/object/src/elf.rs","tests/smoke.sh"],',
    '      "acceptanceCmd":"bash tests/smoke.sh",',
    '      "forbidPatterns":[],"requiredTestPackages":[],"minTestFiles":1,"minTestCases":5,"failOnNoTests":false',
    '    },',
    '    {',
    '      "title":"Integrate driver and multi-target binaries",',
    '      "milestone":"M3",',
    '      "priority":"P0",',
    '      "acceptance":"ccc/ccc-arm/ccc-riscv are wired through a robust shared driver CLI.",',
    '      "prompt":"Implement driver CLI, target selection, output control, and build three binaries.",',
    '      "requiredFiles":["driver/src/main.rs","driver/src/bin/ccc.rs","driver/src/bin/ccc-arm.rs","driver/src/bin/ccc-riscv.rs"],',
    '      "acceptanceCmd":"cargo build --workspace",',
    '      "forbidPatterns":[],"requiredTestPackages":[],"minTestFiles":0,"minTestCases":0,"failOnNoTests":false',
    '    },',
    '    {',
    '      "title":"Conformance, performance, and hardening gates",',
    '      "milestone":"M4",',
    '      "priority":"P0",',
    '      "acceptance":"Conformance/performance/hardening suites are integrated and release docs are complete.",',
    '      "prompt":"Add conformance runner, benchmark harness, reliability checks, and release-ready documentation.",',
    '      "requiredFiles":["tests/conformance/run.sh","scripts/bench.sh","README.md"],',
    '      "acceptanceCmd":"cargo test --workspace",',
    '      "forbidPatterns":["TODO\\\\(critical\\\\)"],"requiredTestPackages":[],"minTestFiles":0,"minTestCases":0,"failOnNoTests":false',
    '    }',
    '  ],',
    '  "globalGates": {',
    '    "requiredFiles":["README.md","tests/conformance/run.sh"],',
    '    "forbidPatterns":["TODO\\\\(critical\\\\)","unimplemented!\\\\(\\\\)"]',
    '  }',
    '}',
    '',
    'Now generate output for the provided requirement.',
    'Return ONLY valid JSON and nothing else. Schema:',
    '{',
    '  "summary": "string",',
    '  "milestones": [{"id":"M1","title":"..."}],',
    '  "tasks": [',
    '    {',
    '      "title":"string",',
    '      "milestone":"M1|M2|M3|M4",',
    '      "priority":"P0|P1|P2",',
    '      "acceptance":"string",',
    '      "prompt":"string",',
    '      "requiredFiles":["optional path"],',
    '      "acceptanceCmd":"optional shell command",',
    '      "forbidPatterns":["optional regex"],',
    '      "requiredTestPackages":["optional package"],',
    '      "minTestFiles":0,',
    '      "minTestCases":0,',
    '      "failOnNoTests":false',
    '    }',
    '  ],',
    '  "globalGates": {',
    '    "requiredFiles":["optional path"],',
    '    "forbidPatterns":["optional regex"]',
    '  }',
    '}'
  ].join('\n');

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(plannerLogPath), { recursive: true });
    const plannerLogStream = fs.createWriteStream(plannerLogPath, { flags: 'w' });

    const child = spawn(
      'codex',
      ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', prompt],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let rawOut = '';
    let rawErr = '';

    streamWithPrefix(child.stdout, '[codex:decompose] ', (text) => {
      rawOut += text;
      plannerLogStream.write(text);
    });
    streamWithPrefix(child.stderr, '[codex:decompose] ', (text) => {
      rawErr += text;
      plannerLogStream.write(text);
    });

    child.on('error', (error) => {
      plannerLogStream.end();
      reject(error);
    });

    child.on('close', (code) => {
      plannerLogStream.end();
      const combined = `${rawOut}\n${rawErr}`.trim();
      if (code !== 0) {
        const tail = combined.split(/\r?\n/).slice(-20).join('\n');
        reject(new Error(`codex decomposition failed (exit=${code}). tail:\n${tail}`));
        return;
      }

      const parsed = extractJsonObject(rawOut) || extractJsonObject(combined);
      if (!parsed || typeof parsed !== 'object') {
        reject(new Error('Unable to parse codex decomposition JSON output.'));
        return;
      }

      const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const normalizedTasksAll = rawTasks
        .map((task, idx) => normalizeTask(task, idx, rawTasks.length))
        .filter((task) => task.title && task.prompt);
      const normalizedTasks = maxTasks ? normalizedTasksAll.slice(0, maxTasks) : normalizedTasksAll;

      if (normalizedTasks.length === 0) {
        reject(new Error('Codex decomposition returned zero valid tasks.'));
        return;
      }

      const milestoneOrder = ['M1', 'M2', 'M3', 'M4'];
      const taskMilestones = unique(normalizedTasks.map((task) => task.milestone).filter((m) => milestoneOrder.includes(m)));
      const milestones = taskMilestones.length > 0
        ? taskMilestones.map((id) => ({ id, title: `Auto milestone ${id}` }))
        : [
            { id: 'M1', title: 'Foundation' },
            { id: 'M2', title: 'Core implementation' },
            { id: 'M3', title: 'Integration and verification' },
            { id: 'M4', title: 'Hardening and release' }
          ];

      const globalGatesRaw = parsed.globalGates && typeof parsed.globalGates === 'object' ? parsed.globalGates : {};
      resolve({
        summary: String(parsed.summary || '').trim(),
        milestones,
        tasks: normalizedTasks,
        globalGates: {
          requiredFiles: unique(toStringList(globalGatesRaw.requiredFiles)),
          forbidPatterns: unique(toStringList(globalGatesRaw.forbidPatterns))
        }
      });
    });
  });
}

function buildPlanMarkdown(planData, decomposeMode) {
  const lines = [];
  lines.push('# Plan');
  lines.push('');
  lines.push('## Decomposition');
  lines.push(`- Mode: ${decomposeMode}`);
  if (planData.summary) lines.push(`- Summary: ${planData.summary}`);
  lines.push('');
  lines.push('## Milestones');
  if (Array.isArray(planData.milestones) && planData.milestones.length > 0) {
    planData.milestones.forEach((m, idx) => {
      lines.push(`${idx + 1}. ${m.id}: ${m.title}`);
    });
  } else {
    lines.push('1. M1: Initial delivery');
  }
  lines.push('');
  lines.push('## Acceptance Rules');
  lines.push('- Each task should be machine-checkable when possible.');
  lines.push('- Planning phase may adjust queue and plan based on findings.');
  lines.push('- Queue empty enters DONE only after global gate succeeds (if configured).');
  return `${lines.join('\n')}\n`;
}

function enqueueTask(task) {
  const args = [
    task.title,
    '--priority', task.priority,
    '--milestone', task.milestone,
    '--acceptance', task.acceptance,
    '--prompt', task.prompt
  ];

  if (task.requiredFiles?.length) args.push('--required-files', task.requiredFiles.join(','));
  if (task.acceptanceCmd) args.push('--acceptance-cmd', task.acceptanceCmd);
  if (task.forbidPatterns?.length) args.push('--forbid-patterns', task.forbidPatterns.join(','));
  if (task.requiredTestPackages?.length) args.push('--required-test-packages', task.requiredTestPackages.join(','));
  if (task.minTestFiles > 0) args.push('--min-test-files', String(task.minTestFiles));
  if (task.minTestCases > 0) args.push('--min-test-cases', String(task.minTestCases));
  if (task.failOnNoTests) args.push('--fail-on-no-tests', 'true');

  runNodeScript('enqueue.mjs', args);
}

const args = parseArgs(process.argv.slice(2));
const requirementInput = args.requirement || args._.join(' ').trim();
if (!requirementInput) {
  console.error('Usage: npm run longrun:bootstrap:task -- --requirement "..." [--objective "..."] [--decompose codex] [--max-tasks N] [--start-runner true]');
  process.exit(1);
}

const objective = String(args.objective || 'Deliver the input requirement with production-grade quality.').trim();
const decomposeMode = String(args.decompose || 'codex').trim().toLowerCase();
if (decomposeMode !== 'codex') {
  throw new Error('Invalid --decompose, expected codex.');
}
const maxTasks = parseOptionalPositiveInt(args['max-tasks']);
const workdir = args.workdir ? resolvePathInput(args.workdir) : makeTempDir('longrun-task-work-');
const artifactsDir = args['artifacts-dir'] ? resolvePathInput(args['artifacts-dir']) : makeTempDir('longrun-task-artifacts-');
const startRunnerFlag = parseBooleanArg(args['start-runner'], false);
const intervalSec = Number(args.interval || 20);

if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
  throw new Error('Invalid --interval value.');
}
if (args.workdir && !fs.existsSync(workdir)) throw new Error(`workdir does not exist: ${workdir}`);
if (args['artifacts-dir'] && !fs.existsSync(artifactsDir)) throw new Error(`artifacts-dir does not exist: ${artifactsDir}`);

const implementHook = [
  'set -e',
  'LOG="{{task_artifacts_dir}}/implement.log"',
  'PIPE="$(mktemp -u "${TMPDIR:-/tmp}/codex-implement.XXXXXX")"',
  'mkfifo "$PIPE"',
  'tee "$LOG" < "$PIPE" | sed -u \'s/^/[codex:implement] /\' &',
  'STREAM_PID=$!',
  'codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "{{task_prompt}}" > "$PIPE" 2>&1',
  'RC=$?',
  'wait "$STREAM_PID" || true',
  'rm -f "$PIPE"',
  'exit "$RC"'
].join('; ');

const verifyHook = [
  'set -e',
  'LOG="{{task_artifacts_dir}}/verify.log"',
  ': > "$LOG"',
  'echo "[verify] auto verifier start" >> "$LOG"',
  'if [ -f "verify.sh" ]; then echo "[verify] bash verify.sh" >> "$LOG"; bash verify.sh >> "$LOG" 2>&1; '
    + 'elif [ -f "package.json" ] && command -v npm >/dev/null 2>&1; then '
    + 'echo "[verify] npm test --if-present" >> "$LOG"; npm test --if-present >> "$LOG" 2>&1; '
    + 'echo "[verify] npm run -s build --if-present" >> "$LOG"; npm run -s build --if-present >> "$LOG" 2>&1; '
    + 'elif [ -f "Cargo.toml" ] && command -v cargo >/dev/null 2>&1; then '
    + 'echo "[verify] cargo test --workspace" >> "$LOG"; cargo test --workspace >> "$LOG" 2>&1; '
    + 'echo "[verify] cargo build --workspace" >> "$LOG"; cargo build --workspace >> "$LOG" 2>&1; '
    + 'elif { [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; } && command -v pytest >/dev/null 2>&1; then '
    + 'echo "[verify] pytest" >> "$LOG"; pytest >> "$LOG" 2>&1; '
    + 'else echo "[verify] no built-in verifier matched; pass" >> "$LOG"; fi'
].join('; ');

const repairHook = [
  'set -e',
  'LOG="{{task_artifacts_dir}}/repair.log"',
  'PIPE="$(mktemp -u "${TMPDIR:-/tmp}/codex-repair.XXXXXX")"',
  'mkfifo "$PIPE"',
  'tee "$LOG" < "$PIPE" | sed -u \'s/^/[codex:repair] /\' &',
  'STREAM_PID=$!',
  'codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "Task {{task_id}} failed verify/acceptance. Read {{task_artifacts_dir}}/verify.log and acceptance artifacts; then fix code in {{workdir}} to satisfy: {{task_acceptance}}. Keep changes production-quality and minimal." > "$PIPE" 2>&1',
  'RC=$?',
  'wait "$STREAM_PID" || true',
  'rm -f "$PIPE"',
  'exit "$RC"'
].join('; ');

const visualizeHook = [
  '{',
  'echo "# {{task_id}} {{task_title}}"',
  'echo "time: $(date -Iseconds)"',
  'echo',
  'echo "## Workdir"',
  'pwd',
  'echo',
  'echo "## Tree(depth=2)"',
  'find . -maxdepth 2 -mindepth 1 | sort',
  'echo',
  'echo "## Git Status"',
  'if [ -d .git ]; then git status --short || true; else echo "(no git repo)"; fi',
  '} > "{{task_artifacts_dir}}/visualize.md"'
].join('; ');

const globalHook = [
  'set -e',
  'mkdir -p "{{artifacts_dir}}/_global"',
  'LOG="{{artifacts_dir}}/_global/verify.log"',
  ': > "$LOG"',
  'echo "[global] auto gate start" >> "$LOG"',
  'if [ -f "verify.sh" ]; then echo "[global] bash verify.sh" >> "$LOG"; bash verify.sh >> "$LOG" 2>&1; '
    + 'elif [ -f "package.json" ] && command -v npm >/dev/null 2>&1; then '
    + 'echo "[global] npm test --if-present" >> "$LOG"; npm test --if-present >> "$LOG" 2>&1; '
    + 'echo "[global] npm run -s build --if-present" >> "$LOG"; npm run -s build --if-present >> "$LOG" 2>&1; '
    + 'elif [ -f "Cargo.toml" ] && command -v cargo >/dev/null 2>&1; then '
    + 'echo "[global] cargo test --workspace" >> "$LOG"; cargo test --workspace >> "$LOG" 2>&1; '
    + 'echo "[global] cargo build --workspace" >> "$LOG"; cargo build --workspace >> "$LOG" 2>&1; '
    + 'elif { [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; } && command -v pytest >/dev/null 2>&1; then '
    + 'echo "[global] pytest" >> "$LOG"; pytest >> "$LOG" 2>&1; '
    + 'else echo "[global] no built-in global verifier matched; pass" >> "$LOG"; fi'
].join('; ');

(async () => {
try {
  console.log('[bootstrap] init longrun');
  runNodeScript('init.mjs', ['--force', '--workdir', workdir, '--artifacts-dir', artifactsDir]);

  const plannerLogPath = path.join(OPS_DIR, 'decompose-codex.log');
  console.log('[bootstrap] decompose by codex (few-shot)');
  const planData = await runCodexDecomposition(requirementInput, objective, maxTasks, plannerLogPath);

  const maxTasksLabel = maxTasks == null ? 'unlimited' : String(maxTasks);
  const promptMd = `# Prompt\n\n## Objective\n${objective}\n\n## Requirement (Input)\n${requirementInput}\n\n## Decomposition\n- Mode: ${decomposeMode}\n- Max Tasks: ${maxTasksLabel}\n- Generated Tasks: ${planData.tasks.length}\n\n## Constraints\n- Keep commits small and reversible.\n- Every task must pass verify + acceptance gates.\n- Preserve maintainability and explicit diagnostics.\n`;

  const planMd = buildPlanMarkdown(planData, decomposeMode);
  ensureOpsFile('active-run.env', `WORKDIR=${workdir}\nARTDIR=${artifactsDir}\n`);
  ensureOpsFile('Prompt.md', promptMd);
  ensureOpsFile('Plan.md', planMd);
  ensureOpsFile('decomposition.json', `${JSON.stringify(planData, null, 2)}\n`);

  const requiredFiles = unique([
    ...toStringList(args['global-required-files']),
    ...toStringList(planData?.globalGates?.requiredFiles)
  ]);
  const forbidPatterns = unique([
    ...toStringList(args['global-forbid-patterns']),
    ...toStringList(planData?.globalGates?.forbidPatterns)
  ]);

  console.log('[bootstrap] configure hooks/gates');
  const configureArgs = [
    '--implement', implementHook,
    '--verify', verifyHook,
    '--acceptance', 'echo "[acceptance] declarative task gates" > "{{task_artifacts_dir}}/acceptance.log"',
    '--repair', repairHook,
    '--visualize', visualizeHook,
    '--globalAcceptance', globalHook
  ];
  if (requiredFiles.length > 0) configureArgs.push('--global-required-files', requiredFiles.join(','));
  if (forbidPatterns.length > 0) configureArgs.push('--global-forbid-patterns', forbidPatterns.join(','));
  runNodeScript('configure.mjs', configureArgs);

  console.log(`[bootstrap] enqueue ${planData.tasks.length} tasks`);
  for (const task of planData.tasks) enqueueTask(task);

  const queueLines = fs.existsSync(QUEUE_PATH)
    ? fs.readFileSync(QUEUE_PATH, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).length
    : 0;

  console.log('[bootstrap] queue ready');
  console.log(`WORKDIR=${workdir}`);
  console.log(`ARTDIR=${artifactsDir}`);
  console.log(`TASKS=${queueLines}`);

  if (startRunnerFlag) {
    console.log('[bootstrap] start background runner');
    const pid = startRunner(intervalSec);
    console.log(`RUNNER_PID=${pid}`);
    console.log(`RUNNER_LOG=${path.join(OPS_DIR, 'longrun-daemon.log')}`);
  }
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
})();
