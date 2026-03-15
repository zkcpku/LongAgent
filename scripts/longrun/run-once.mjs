#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OPS_DIR,
  ROOT,
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_INIT_PLANNING_HOOK,
  DEFAULT_PLANNING_HOOK,
  DEFAULT_REPAIR_HOOK,
  DEFAULT_REPAIR_MAX_ATTEMPTS,
  STATE_PATH,
  QUEUE_PATH,
  writeJson,
  readJsonl,
  writeJsonl,
  nowIso,
  requireState,
  getCurrentTask,
  nextTaskId,
  normalizeGates,
  setTask,
  appendEvent,
  runHook,
  printHookResult,
  acquireLock,
  releaseLock,
  updateState,
  writeSnapshot,
  ensureDir,
  ensureDirExists
} from './lib.mjs';

function abort(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function contextFrom(task, state, runtime) {
  const repairAttempt = Number.isFinite(Number(task?.repairAttempts)) ? Number(task.repairAttempts) : 0;
  const repairMaxAttempts = Number(state?.repairMaxAttempts) > 0
    ? Number(state.repairMaxAttempts)
    : DEFAULT_REPAIR_MAX_ATTEMPTS;
  return {
    task_id: task?.id || '',
    task_title: task?.title || '',
    task_prompt: task?.prompt || '',
    task_acceptance: task?.acceptance || '',
    task_milestone: task?.milestone || '',
    task_repair_attempt: repairAttempt,
    task_repair_max_attempts: repairMaxAttempts,
    runner_root: runtime.runnerRoot,
    ops_dir: runtime.opsDir,
    queue_path: runtime.queuePath,
    plan_path: runtime.planPath,
    prompt_path: runtime.promptPath,
    workdir: runtime.workdir,
    artifacts_dir: runtime.artifactsDir,
    task_artifacts_dir: runtime.taskArtifactsDir || '',
    verify_log_path: runtime.taskArtifactsDir ? path.join(runtime.taskArtifactsDir, 'verify.log') : '',
    phase: state.phase || ''
  };
}

function readTextIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseTokensUsed(text) {
  if (!text) return null;
  const regex = /tokens used\s*:?\s*([\d,]+)/gi;
  const matches = [...String(text).matchAll(regex)];
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1]?.[1];
  if (!raw) return null;
  const parsed = Number(raw.replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function extractRedirectPath(command, cwd) {
  if (!command) return null;
  const match = String(command).match(/>\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (!match) return null;
  const raw = (match[1] || match[2] || match[3] || '').trim();
  if (!raw || raw === '/dev/null') return null;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(cwd, raw);
}

function detectHookTokens(result, hookName, runtime, cwd) {
  const candidates = [];
  const redirected = extractRedirectPath(result.command, cwd);
  if (redirected) candidates.push(redirected);
  if (runtime.taskArtifactsDir) {
    candidates.push(path.join(runtime.taskArtifactsDir, `${hookName}.log`));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const content = readTextIfExists(candidate);
    const tokensUsed = parseTokensUsed(content);
    if (Number.isFinite(tokensUsed)) {
      return { tokensUsed, tokenSource: candidate };
    }
  }

  const directTokens =
    parseTokensUsed(result.stdout || '') ??
    parseTokensUsed(result.stderr || '') ??
    null;

  return {
    tokensUsed: Number.isFinite(directTokens) ? directTokens : 0,
    tokenSource: null
  };
}

function normalizeTaskMetrics(metrics) {
  const safe = metrics && typeof metrics === 'object' ? metrics : {};
  const byHook = safe.byHook && typeof safe.byHook === 'object' ? safe.byHook : {};
  return {
    stepCount: Number(safe.stepCount) || 0,
    totalDurationMs: Number(safe.totalDurationMs) || 0,
    totalTokensUsed: Number(safe.totalTokensUsed) || 0,
    byHook
  };
}

function accumulateTaskMetrics(task, hookName, phase, result, tokensUsed) {
  const current = normalizeTaskMetrics(task?.metrics);
  const durationMs = Number(result?.durationMs) || 0;
  const safeTokens = Number(tokensUsed) || 0;
  const hookCurrent = current.byHook[hookName] || {};

  const hookNext = {
    count: (Number(hookCurrent.count) || 0) + 1,
    durationMs: (Number(hookCurrent.durationMs) || 0) + durationMs,
    tokensUsed: (Number(hookCurrent.tokensUsed) || 0) + safeTokens,
    lastPhase: phase || '',
    lastAt: new Date().toISOString()
  };

  return {
    stepCount: current.stepCount + 1,
    totalDurationMs: current.totalDurationMs + durationMs,
    totalTokensUsed: current.totalTokensUsed + safeTokens,
    byHook: {
      ...current.byHook,
      [hookName]: hookNext
    }
  };
}

function appendTaskStepRecord(runtime, row) {
  if (!runtime?.taskArtifactsDir) return;
  const filePath = path.join(runtime.taskArtifactsDir, 'steps.jsonl');
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function hasConfiguredGates(rawGates) {
  const gates = normalizeGates(rawGates);
  return (
    Boolean(gates.cmd) ||
    gates.requiredFiles.length > 0 ||
    gates.forbidPatterns.length > 0 ||
    gates.requiredTestPackages.length > 0 ||
    gates.minTestFiles > 0 ||
    gates.minTestCases > 0 ||
    gates.failOnNoTests
  );
}

function parseVerifyLogStats(logPathsInput) {
  const rawPaths = Array.isArray(logPathsInput) ? logPathsInput : [logPathsInput];
  const logPaths = rawPaths.filter((p) => Boolean(String(p || '').trim()));
  const lines = [];
  for (const logPath of logPaths) {
    const text = readTextIfExists(logPath);
    if (!text) continue;
    lines.push(...text.split(/\r?\n/));
  }
  const noTestPackages = new Set();
  const seenPackages = new Set();
  const uniqueTestFiles = new Set();
  let noTestsCount = 0;
  let testFiles = 0;
  let testCases = 0;

  for (const line of lines) {
    const pkgMatch = line.match(/^(\S+)\s+test:\s+(.*)$/);
    if (pkgMatch) {
      const pkg = pkgMatch[1];
      const body = pkgMatch[2] || '';
      seenPackages.add(pkg);
      if (/No test files found/i.test(body)) {
        noTestsCount += 1;
        noTestPackages.add(pkg);
      }
    }

    const filesMatch = line.match(/Test Files\s+(\d+)\s+passed/i);
    if (filesMatch) {
      testFiles += Number(filesMatch[1]) || 0;
    }
    const testMatch = line.match(/Tests\s+(\d+)\s+passed/i);
    if (testMatch) {
      testCases += Number(testMatch[1]) || 0;
    }

    const vitestFileMatch = line.match(/^\s*✓\s+([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?)/);
    if (vitestFileMatch?.[1]) {
      uniqueTestFiles.add(vitestFileMatch[1]);
    }

    const playwrightSpecMatch = line.match(/›\s+([^\s:]+(?:\.test|\.spec)\.[cm]?[jt]sx?)(?::\d+:\d+)?\s+›/);
    if (playwrightSpecMatch?.[1]) {
      uniqueTestFiles.add(playwrightSpecMatch[1]);
    }

    const playwrightPassedMatch = line.match(/^\s*(\d+)\s+passed\s*\(/i);
    if (playwrightPassedMatch) {
      testCases += Number(playwrightPassedMatch[1]) || 0;
    }
  }

  if (uniqueTestFiles.size > 0) {
    testFiles = Math.max(testFiles, uniqueTestFiles.size);
  }

  return {
    verifyLogPath: logPaths[0] || '',
    logPaths,
    noTestsCount,
    noTestPackages: [...noTestPackages],
    seenPackages: [...seenPackages],
    testFiles,
    testCases
  };
}

function searchPatternInWorkdir(pattern, workdir) {
  const rg = spawnSync(
    'rg',
    ['-n', '-S', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--glob', '!dist', pattern, '.'],
    { cwd: workdir, encoding: 'utf8' }
  );
  if (rg.status === 0) {
    return {
      ok: true,
      matched: true,
      output: (rg.stdout || '').trim()
    };
  }
  if (rg.status === 1) {
    return {
      ok: true,
      matched: false,
      output: ''
    };
  }
  if (rg.error && rg.error.code === 'ENOENT') {
    const grep = spawnSync(
      'grep',
      ['-R', '-n', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=dist', pattern, '.'],
      { cwd: workdir, encoding: 'utf8' }
    );
    return {
      ok: grep.status === 0 || grep.status === 1,
      matched: grep.status === 0,
      output: (grep.stdout || '').trim(),
      error: grep.status > 1 ? (grep.stderr || '').trim() : ''
    };
  }
  return {
    ok: false,
    matched: false,
    output: '',
    error: (rg.stderr || '').trim() || `pattern search failed (status=${rg.status})`
  };
}

function evaluateDeclarativeGates(rawGates, options = {}) {
  const gates = normalizeGates(rawGates);
  const workdir = options.workdir || ROOT;
  const verifyLogPath = options.verifyLogPath || '';
  const additionalLogPaths = Array.isArray(options.additionalLogPaths) ? options.additionalLogPaths : [];
  const failures = [];
  const diagnostics = {
    verify: parseVerifyLogStats([verifyLogPath, ...additionalLogPaths]),
    patternChecks: []
  };

  for (const relPath of gates.requiredFiles) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(workdir, relPath);
    if (!fs.existsSync(absPath)) {
      failures.push(`required file missing: ${relPath}`);
    }
  }

  for (const pattern of gates.forbidPatterns) {
    const found = searchPatternInWorkdir(pattern, workdir);
    diagnostics.patternChecks.push({
      pattern,
      ok: found.ok,
      matched: found.matched,
      output: found.output,
      error: found.error || ''
    });
    if (!found.ok) {
      failures.push(`forbid pattern check failed: ${pattern}`);
    } else if (found.matched) {
      failures.push(`forbid pattern matched: ${pattern}`);
    }
  }

  if (gates.failOnNoTests && diagnostics.verify.noTestsCount > 0) {
    failures.push(`verify reported packages with no tests (${diagnostics.verify.noTestsCount})`);
  }

  const noTestSet = new Set(diagnostics.verify.noTestPackages);
  const seenSet = new Set(diagnostics.verify.seenPackages);
  for (const pkg of gates.requiredTestPackages) {
    if (!seenSet.has(pkg)) {
      failures.push(`required test package not observed in verify log: ${pkg}`);
      continue;
    }
    if (noTestSet.has(pkg)) {
      failures.push(`required test package has no tests: ${pkg}`);
    }
  }

  if (gates.minTestFiles > 0 && diagnostics.verify.testFiles < gates.minTestFiles) {
    failures.push(
      `minTestFiles not met: expected >= ${gates.minTestFiles}, got ${diagnostics.verify.testFiles}`
    );
  }

  if (gates.minTestCases > 0 && diagnostics.verify.testCases < gates.minTestCases) {
    failures.push(
      `minTestCases not met: expected >= ${gates.minTestCases}, got ${diagnostics.verify.testCases}`
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    diagnostics
  };
}

function saveAll(state, queue) {
  writeJson(STATE_PATH, state);
  writeJsonl(QUEUE_PATH, queue);
  writeSnapshot(state, queue);
}

let lockFd;
try {
  lockFd = acquireLock();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}

try {
  let state = requireState();
  let queue = readJsonl(QUEUE_PATH);
  const workdir = state.workdir || ROOT;
  const artifactsDir = state.artifactsDir || DEFAULT_ARTIFACTS_DIR;

  ensureDirExists(workdir, 'workdir');
  ensureDir(artifactsDir);

  if (!state.workdir || !state.artifactsDir) {
    state = updateState(state, {
      workdir,
      artifactsDir
    });
  }

  if (!state.hooks || typeof state.hooks !== 'object') {
    state = updateState(state, { hooks: {} });
  }
  if (!Object.prototype.hasOwnProperty.call(state.hooks, 'initPlanning')) {
    state = updateState(state, {
      hooks: {
        ...state.hooks,
        initPlanning: DEFAULT_INIT_PLANNING_HOOK
      }
    });
  }
  if (!Object.prototype.hasOwnProperty.call(state.hooks, 'repair')) {
    state = updateState(state, {
      hooks: {
        ...state.hooks,
        repair: DEFAULT_REPAIR_HOOK
      }
    });
  }
  if (!Object.prototype.hasOwnProperty.call(state.hooks, 'acceptance')) {
    state = updateState(state, {
      hooks: {
        ...state.hooks,
        acceptance: ''
      }
    });
  }
  if (!Object.prototype.hasOwnProperty.call(state.hooks, 'globalAcceptance')) {
    state = updateState(state, {
      hooks: {
        ...state.hooks,
        globalAcceptance: ''
      }
    });
  }
  if (!Object.prototype.hasOwnProperty.call(state.hooks, 'planning')) {
    state = updateState(state, {
      hooks: {
        ...state.hooks,
        planning: DEFAULT_PLANNING_HOOK
      }
    });
  }
  if (!state.repairMaxAttempts || Number(state.repairMaxAttempts) <= 0) {
    state = updateState(state, { repairMaxAttempts: DEFAULT_REPAIR_MAX_ATTEMPTS });
  }
  if (!Object.prototype.hasOwnProperty.call(state, 'initPlanningDone')) {
    state = updateState(state, { initPlanningDone: false });
  }
  if (!state.globalGates || typeof state.globalGates !== 'object') {
    state = updateState(state, { globalGates: normalizeGates({}) });
  } else {
    state = updateState(state, { globalGates: normalizeGates(state.globalGates) });
  }

  if (!Array.isArray(queue)) {
    abort('Invalid queue format. Expected JSONL records in ops/queue.jsonl.');
  }

  if (state.phase === 'BLOCKED') {
    abort(`state is BLOCKED: ${state.blockedReason || 'unknown reason'}`, 2);
  }

  let currentTask = getCurrentTask(queue, state);

  if (!currentTask) {
    const hasInitPlanningHook = Boolean(String(state.hooks?.initPlanning || '').trim());
    const shouldRunInitPlanning = hasInitPlanningHook && !Boolean(state.initPlanningDone) && queue.length === 0;
    let skipGlobalEvaluation = false;

    if (shouldRunInitPlanning) {
      const initArtifactsDir = path.join(artifactsDir, '_initPlanning');
      ensureDir(initArtifactsDir);
      const initRuntime = {
        runnerRoot: ROOT,
        opsDir: OPS_DIR,
        queuePath: QUEUE_PATH,
        planPath: path.join(OPS_DIR, 'Plan.md'),
        promptPath: path.join(OPS_DIR, 'Prompt.md'),
        workdir,
        artifactsDir,
        taskArtifactsDir: initArtifactsDir
      };

      const initResult = runHook(state.hooks.initPlanning, contextFrom(null, state, initRuntime), {
        cwd: workdir,
        liveOutput: true
      });
      printHookResult('initPlanning', initResult);

      appendEvent('init_planning_executed', {
        phase: state.phase,
        hook: 'initPlanning',
        skipped: initResult.skipped,
        ok: initResult.ok,
        command: initResult.command || '',
        cwd: workdir,
        startedAt: initResult.startedAt || null,
        endedAt: initResult.endedAt || null,
        durationMs: initResult.durationMs ?? 0,
        exitCode: initResult.exitCode ?? 0
      });

      if (!initResult.ok) {
        state = updateState(state, {
          phase: 'BLOCKED',
          blockedReason: 'initPlanning failed',
          currentTaskId: null,
          lastRunAt: new Date().toISOString()
        });
        appendEvent('runner_blocked', {
          reason: 'initPlanning failed',
          command: initResult.command || '',
          exitCode: initResult.exitCode ?? null
        });
        saveAll(state, queue);
        abort('blocked: initPlanning failed', 2);
      }

      const refreshedQueue = readJsonl(QUEUE_PATH);
      if (Array.isArray(refreshedQueue)) {
        queue = refreshedQueue;
      }
      currentTask = getCurrentTask(queue, state);

      state = updateState(state, {
        initPlanningDone: true,
        phase: 'PLANNING',
        currentTaskId: null,
        blockedReason: null,
        lastRunAt: new Date().toISOString()
      });
      appendEvent('init_planning_completed', {
        queueSize: queue.length,
        hasTask: Boolean(currentTask)
      });
      saveAll(state, queue);

      if (currentTask) {
        skipGlobalEvaluation = true;
        console.log(`initPlanning produced tasks, next task ${currentTask.id}`);
      }
    }

    if (skipGlobalEvaluation) {
      // Queue has been seeded by initPlanning. Process starts from next iteration.
      currentTask = null;
    }

    if (!skipGlobalEvaluation) {
    const globalGates = normalizeGates(state.globalGates);
    const hasGlobalDeclarative = hasConfiguredGates(globalGates);
    const hasGlobalHook = Boolean(String(state.hooks?.globalAcceptance || '').trim());
    const shouldEvaluateGlobal = hasGlobalDeclarative || hasGlobalHook;

    if (!shouldEvaluateGlobal) {
      state = updateState(state, {
        phase: 'DONE',
        currentTaskId: null,
        blockedReason: null,
        lastRunAt: new Date().toISOString()
      });
      appendEvent('runner_idle', { phase: state.phase });
      saveAll(state, queue);
      console.log('no pending task, phase -> DONE');
    } else {
      const globalArtifactsDir = path.join(artifactsDir, '_global');
      ensureDir(globalArtifactsDir);
      const runtime = {
        runnerRoot: ROOT,
        opsDir: OPS_DIR,
        queuePath: QUEUE_PATH,
        planPath: path.join(OPS_DIR, 'Plan.md'),
        promptPath: path.join(OPS_DIR, 'Prompt.md'),
        workdir,
        artifactsDir,
        taskArtifactsDir: globalArtifactsDir
      };

      let hookResult = {
        ok: true,
        skipped: true,
        command: '',
        durationMs: 0,
        exitCode: 0
      };

      if (hasGlobalHook) {
        hookResult = runHook(state.hooks.globalAcceptance, contextFrom(null, state, runtime), {
          cwd: workdir,
          liveOutput: true
        });
        printHookResult('globalAcceptance', hookResult);
      } else {
        printHookResult('globalAcceptance', hookResult);
      }

      appendEvent('global_hook_executed', {
        phase: state.phase,
        hook: 'globalAcceptance',
        skipped: hookResult.skipped,
        ok: hookResult.ok,
        command: hookResult.command || '',
        cwd: workdir,
        startedAt: hookResult.startedAt || null,
        endedAt: hookResult.endedAt || null,
        durationMs: hookResult.durationMs ?? 0,
        exitCode: hookResult.exitCode ?? 0
      });

      const declarativeResult = evaluateDeclarativeGates(globalGates, {
        workdir,
        verifyLogPath: path.join(globalArtifactsDir, 'verify.log')
      });

      const globalFailures = [];
      if (!hookResult.ok) {
        globalFailures.push('global acceptance hook failed');
      }
      if (!declarativeResult.ok) {
        globalFailures.push(...declarativeResult.failures);
      }

      const globalGateOk = globalFailures.length === 0;
      appendEvent('global_gate_evaluated', {
        ok: globalGateOk,
        hasGlobalHook,
        hasGlobalDeclarative,
        failures: globalFailures,
        diagnostics: declarativeResult.diagnostics
      });

      if (globalGateOk) {
        appendEvent('global_gate_passed', {});
        state = updateState(state, {
          phase: 'DONE',
          currentTaskId: null,
          blockedReason: null,
          lastRunAt: new Date().toISOString()
        });
        appendEvent('runner_idle', { phase: state.phase });
        saveAll(state, queue);
        console.log('queue empty and global gate passed, phase -> DONE');
      } else {
        const taskId = nextTaskId(queue);
        const failureText = globalFailures.slice(0, 10).join('; ');
        const autoTask = {
          id: taskId,
          title: 'Auto repair global acceptance gates',
          milestone: state.milestone || 'M1',
          priority: 'P0',
          acceptance: 'Global acceptance gates pass when queue becomes empty.',
          prompt: [
            'Global acceptance gates failed.',
            `Failures: ${failureText || 'unknown failure'}.`,
            `Fix code/config in ${workdir} until global gates pass.`,
            'Use latest global diagnostics from ops/events.jsonl (global_gate_evaluated).'
          ].join(' '),
          notes: 'Auto-generated task from global gate failure.',
          status: 'PENDING',
          gates: globalGates,
          autoGenerated: true,
          autoKind: 'GLOBAL_GATE_REPAIR',
          metrics: {
            stepCount: 0,
            totalDurationMs: 0,
            totalTokensUsed: 0,
            byHook: {}
          },
          createdAt: nowIso(),
          startedAt: null,
          completedAt: null,
          lastUpdated: nowIso(),
          repairAttempts: 0
        };
        queue.push(autoTask);
        appendEvent('task_enqueued_auto', {
          taskId: autoTask.id,
          title: autoTask.title,
          autoKind: autoTask.autoKind,
          reason: 'global_gate_failed'
        });
        state = updateState(state, {
          phase: 'PLANNING',
          currentTaskId: null,
          blockedReason: null,
          lastRunAt: new Date().toISOString()
        });
        saveAll(state, queue);
        console.log(`global gate failed, auto task enqueued: ${autoTask.id}`);
      }
    }
    }
  } else {
    const taskArtifactsDir = path.join(artifactsDir, currentTask.id);
    ensureDir(taskArtifactsDir);
    const runtime = {
      runnerRoot: ROOT,
      opsDir: OPS_DIR,
      queuePath: QUEUE_PATH,
      planPath: path.join(OPS_DIR, 'Plan.md'),
      promptPath: path.join(OPS_DIR, 'Prompt.md'),
      workdir,
      artifactsDir,
      taskArtifactsDir
    };

    if (!state.currentTaskId) {
      state = updateState(state, {
        currentTaskId: currentTask.id,
        phase: state.phase === 'DONE' ? 'PLANNING' : state.phase
      });
    }

    if (currentTask.status === 'PENDING') {
      queue = setTask(queue, currentTask.id, {
        status: 'IN_PROGRESS',
        startedAt: new Date().toISOString(),
        repairAttempts: 0,
        metrics: normalizeTaskMetrics(currentTask.metrics)
      });
      currentTask = queue.find((task) => task.id === currentTask.id);
      appendEvent('task_started', {
        taskId: currentTask.id,
        title: currentTask.title
      });
    }

    const markBlocked = (reason, hookName, hookResult) => {
      queue = setTask(queue, currentTask.id, {
        status: 'BLOCKED'
      });
      state = updateState(state, {
        phase: 'BLOCKED',
        blockedReason: reason,
        lastRunAt: new Date().toISOString()
      });
      appendEvent('task_blocked', {
        taskId: currentTask.id,
        phase: state.phase,
        reason,
        hook: hookName,
        command: hookResult?.command || '',
        exitCode: hookResult?.exitCode ?? null,
        cumulativeDurationMs: Number(currentTask?.metrics?.totalDurationMs) || 0,
        cumulativeTokensUsed: Number(currentTask?.metrics?.totalTokensUsed) || 0
      });
      saveAll(state, queue);
      abort(`blocked: ${reason}`, 2);
    };

    const transition = (toPhase) => {
      const from = state.phase;
      state = updateState(state, {
        phase: toPhase,
        blockedReason: null,
        lastRunAt: new Date().toISOString()
      });
      appendEvent('phase_transition', {
        from,
        to: toPhase,
        taskId: currentTask.id
      });
    };

    const runPhaseHook = (hookName, options = {}) => {
      const blockOnFailure = options.blockOnFailure !== false;
      const fallbackHook = options.fallbackHook || '';
      const hook = options.commandOverride || state.hooks?.[hookName] || fallbackHook;
      const result = runHook(hook, contextFrom(currentTask, state, runtime), {
        cwd: workdir,
        liveOutput: true
      });
      const tokenMetrics = detectHookTokens(result, hookName, runtime, workdir);
      const metrics = accumulateTaskMetrics(
        currentTask,
        hookName,
        state.phase,
        result,
        tokenMetrics.tokensUsed
      );
      queue = setTask(queue, currentTask.id, { metrics });
      currentTask = queue.find((task) => task.id === currentTask.id) || currentTask;

      appendTaskStepRecord(runtime, {
        at: new Date().toISOString(),
        taskId: currentTask.id,
        phase: state.phase,
        hook: hookName,
        ok: result.ok,
        skipped: result.skipped,
        exitCode: result.exitCode ?? 0,
        durationMs: result.durationMs ?? 0,
        tokensUsed: tokenMetrics.tokensUsed,
        cumulativeDurationMs: metrics.totalDurationMs,
        cumulativeTokensUsed: metrics.totalTokensUsed,
        tokenSource: tokenMetrics.tokenSource
      });

      appendEvent('hook_executed', {
        taskId: currentTask.id,
        phase: state.phase,
        hook: hookName,
        skipped: result.skipped,
        ok: result.ok,
        command: result.command,
        cwd: workdir,
        startedAt: result.startedAt || null,
        endedAt: result.endedAt || null,
        durationMs: result.durationMs ?? 0,
        tokensUsed: tokenMetrics.tokensUsed,
        cumulativeDurationMs: metrics.totalDurationMs,
        cumulativeTokensUsed: metrics.totalTokensUsed,
        tokenSource: tokenMetrics.tokenSource,
        stepCount: metrics.stepCount,
        exitCode: result.exitCode ?? 0
      });
      printHookResult(hookName, result);
      if (!result.ok && blockOnFailure) {
        markBlocked(`${hookName} failed`, hookName, result);
      }
      return result;
    };

    const routeFailureToRepair = (eventType, payload = {}) => {
      const maxAttempts = Number(state.repairMaxAttempts) || DEFAULT_REPAIR_MAX_ATTEMPTS;
      const nextAttempt = (Number(currentTask.repairAttempts) || 0) + 1;
      queue = setTask(queue, currentTask.id, { repairAttempts: nextAttempt });
      currentTask = queue.find((task) => task.id === currentTask.id) || currentTask;

      appendEvent(eventType, {
        taskId: currentTask.id,
        attempt: nextAttempt,
        maxAttempts,
        ...payload
      });

      if (nextAttempt > maxAttempts) {
        markBlocked(`${eventType} after ${maxAttempts} repair attempts`, eventType, {
          command: payload.command || '',
          exitCode: payload.exitCode ?? 1
        });
      }

      transition('REPAIRING');
      saveAll(state, queue);
      console.log(`phase VERIFYING -> REPAIRING (${currentTask.id}) attempt ${nextAttempt}/${maxAttempts}`);
    };

    switch (state.phase) {
      case 'PLANNING': {
        const queueBefore = readTextIfExists(runtime.queuePath);
        const planBefore = readTextIfExists(runtime.planPath);
        const planningResult = runPhaseHook('planning', {
          blockOnFailure: false,
          fallbackHook: DEFAULT_PLANNING_HOOK
        });

        const queueAfter = readTextIfExists(runtime.queuePath);
        const planAfter = readTextIfExists(runtime.planPath);
        appendEvent('planning_evaluated', {
          taskId: currentTask.id,
          queueChanged: queueBefore !== queueAfter,
          planChanged: planBefore !== planAfter,
          ok: planningResult.ok
        });
        if (!planningResult.ok) {
          appendEvent('planning_failed', {
            taskId: currentTask.id,
            command: planningResult.command || '',
            exitCode: planningResult.exitCode ?? null
          });
        }

        const refreshedQueue = readJsonl(QUEUE_PATH);
        if (Array.isArray(refreshedQueue)) {
          queue = refreshedQueue;
        }
        const refreshedTask = getCurrentTask(queue, state);
        if (!refreshedTask) {
          state = updateState(state, {
            phase: 'PLANNING',
            currentTaskId: null,
            blockedReason: null,
            lastRunAt: new Date().toISOString()
          });
          saveAll(state, queue);
          console.log('planning changed queue to empty, will evaluate global gate next iteration');
          break;
        }
        currentTask = refreshedTask;
        if (state.currentTaskId !== currentTask.id) {
          state = updateState(state, {
            currentTaskId: currentTask.id
          });
        }
        transition('IMPLEMENTING');
        saveAll(state, queue);
        console.log(`phase PLANNING -> IMPLEMENTING (${currentTask.id})`);
        break;
      }
      case 'IMPLEMENTING': {
        runPhaseHook('implement');
        transition('VERIFYING');
        saveAll(state, queue);
        console.log(`phase IMPLEMENTING -> VERIFYING (${currentTask.id})`);
        break;
      }
      case 'VERIFYING': {
        const verifyResult = runPhaseHook('verify', { blockOnFailure: false });
        if (!verifyResult.ok) {
          routeFailureToRepair('verify_failed', {
            command: verifyResult.command || '',
            exitCode: verifyResult.exitCode ?? null
          });
          break;
        }

        const taskGates = normalizeGates(currentTask.gates);
        const hasTaskDeclarativeGates = hasConfiguredGates(taskGates);
        const acceptanceHook = String(state.hooks?.acceptance || '').trim();
        const hasTaskAcceptanceHook = Boolean(acceptanceHook);
        let acceptanceHookResult = {
          ok: true,
          skipped: true,
          command: '',
          exitCode: 0
        };
        const acceptanceCmdLogPath = path.join(taskArtifactsDir, 'acceptance-cmd.log');
        let acceptanceCmdResult = {
          ok: true,
          skipped: true,
          command: '',
          exitCode: 0
        };

        if (hasTaskAcceptanceHook) {
          acceptanceHookResult = runPhaseHook('acceptance', { blockOnFailure: false });
        } else {
          printHookResult('acceptance', acceptanceHookResult);
        }

        if (taskGates.cmd) {
          acceptanceCmdResult = runPhaseHook('acceptance_cmd', {
            blockOnFailure: false,
            commandOverride: `set -e; (${taskGates.cmd}) > "${acceptanceCmdLogPath}" 2>&1`
          });
        }

        const declarativeResult = evaluateDeclarativeGates(taskGates, {
          workdir,
          verifyLogPath: path.join(taskArtifactsDir, 'verify.log'),
          additionalLogPaths: [acceptanceCmdLogPath]
        });
        const acceptanceFailures = [];
        if (!acceptanceHookResult.ok) {
          acceptanceFailures.push('acceptance hook failed');
        }
        if (!acceptanceCmdResult.ok) {
          acceptanceFailures.push('acceptance cmd failed');
        }
        if (!declarativeResult.ok) {
          acceptanceFailures.push(...declarativeResult.failures);
        }

        appendEvent('acceptance_evaluated', {
          taskId: currentTask.id,
          ok: acceptanceFailures.length === 0,
          hasAcceptanceHook: hasTaskAcceptanceHook,
          hasDeclarativeGates: hasTaskDeclarativeGates,
          hasAcceptanceCmd: Boolean(taskGates.cmd),
          failures: acceptanceFailures,
          diagnostics: declarativeResult.diagnostics
        });

        if (acceptanceFailures.length > 0) {
          routeFailureToRepair('acceptance_failed', {
            command: acceptanceCmdResult.command || acceptanceHookResult.command || '',
            exitCode: acceptanceCmdResult.exitCode ?? acceptanceHookResult.exitCode ?? 1,
            failures: acceptanceFailures
          });
          break;
        }

        queue = setTask(queue, currentTask.id, { repairAttempts: 0 });
        currentTask = queue.find((task) => task.id === currentTask.id);
        transition('VISUALIZING');
        saveAll(state, queue);
        console.log(`phase VERIFYING -> VISUALIZING (${currentTask.id})`);
        break;
      }
      case 'REPAIRING': {
        const repairResult = runPhaseHook('repair', {
          blockOnFailure: false,
          fallbackHook: DEFAULT_REPAIR_HOOK
        });
        if (!repairResult.ok) {
          markBlocked('repair failed', 'repair', repairResult);
        }
        appendEvent('repair_succeeded', {
          taskId: currentTask.id,
          attempt: Number(currentTask.repairAttempts) || 0,
          maxAttempts: Number(state.repairMaxAttempts) || DEFAULT_REPAIR_MAX_ATTEMPTS
        });
        transition('VERIFYING');
        saveAll(state, queue);
        console.log(`phase REPAIRING -> VERIFYING (${currentTask.id})`);
        break;
      }
      case 'VISUALIZING': {
        runPhaseHook('visualize');
        transition('CHECKPOINT');
        saveAll(state, queue);
        console.log(`phase VISUALIZING -> CHECKPOINT (${currentTask.id})`);
        break;
      }
      case 'CHECKPOINT': {
        runPhaseHook('checkpoint');
        queue = setTask(queue, currentTask.id, {
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          repairAttempts: 0
        });
        appendEvent('task_completed', {
          taskId: currentTask.id,
          title: currentTask.title,
          cumulativeDurationMs: Number(currentTask?.metrics?.totalDurationMs) || 0,
          cumulativeTokensUsed: Number(currentTask?.metrics?.totalTokensUsed) || 0
        });
        state = updateState(state, {
          phase: 'PLANNING',
          currentTaskId: null,
          blockedReason: null,
          lastRunAt: new Date().toISOString()
        });
        saveAll(state, queue);
        console.log(`task completed ${currentTask.id}, phase -> PLANNING`);
        break;
      }
      case 'DONE': {
        state = updateState(state, {
          phase: 'PLANNING',
          blockedReason: null,
          lastRunAt: new Date().toISOString()
        });
        transition('IMPLEMENTING');
        saveAll(state, queue);
        console.log(`phase DONE -> IMPLEMENTING (${currentTask.id})`);
        break;
      }
      default: {
        abort(`Unsupported phase: ${state.phase}`);
      }
    }
  }
} catch (error) {
  console.error(String(error.message || error));
  process.exitCode = error.exitCode || 1;
} finally {
  releaseLock(lockFd);
}
