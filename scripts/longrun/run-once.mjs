#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  OPS_DIR,
  ROOT,
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_PLANNING_HOOK,
  DEFAULT_REPAIR_HOOK,
  DEFAULT_REPAIR_MAX_ATTEMPTS,
  STATE_PATH,
  QUEUE_PATH,
  writeJson,
  readJsonl,
  writeJsonl,
  requireState,
  getCurrentTask,
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
  if (!Object.prototype.hasOwnProperty.call(state.hooks, 'repair')) {
    state = updateState(state, {
      hooks: {
        ...state.hooks,
        repair: DEFAULT_REPAIR_HOOK
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

  if (!Array.isArray(queue)) {
    abort('Invalid queue format. Expected JSONL records in ops/queue.jsonl.');
  }

  if (state.phase === 'BLOCKED') {
    abort(`state is BLOCKED: ${state.blockedReason || 'unknown reason'}`, 2);
  }

  let currentTask = getCurrentTask(queue, state);

  if (!currentTask) {
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
    const taskArtifactsDir = path.join(artifactsDir, currentTask.id);
    ensureDir(taskArtifactsDir);
    const runtime = {
      runnerRoot: ROOT,
      opsDir: OPS_DIR,
      queuePath: QUEUE_PATH,
      planPath: path.join(OPS_DIR, 'Plan.md'),
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
      const hook = state.hooks?.[hookName] || fallbackHook;
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
            phase: 'DONE',
            currentTaskId: null,
            blockedReason: null,
            lastRunAt: new Date().toISOString()
          });
          appendEvent('runner_idle', { phase: state.phase });
          saveAll(state, queue);
          console.log('planning changed queue to empty, phase -> DONE');
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
          const maxAttempts = Number(state.repairMaxAttempts) || DEFAULT_REPAIR_MAX_ATTEMPTS;
          const nextAttempt = (Number(currentTask.repairAttempts) || 0) + 1;
          queue = setTask(queue, currentTask.id, { repairAttempts: nextAttempt });
          currentTask = queue.find((task) => task.id === currentTask.id);

          appendEvent('verify_failed', {
            taskId: currentTask.id,
            attempt: nextAttempt,
            maxAttempts: maxAttempts,
            command: verifyResult.command || '',
            exitCode: verifyResult.exitCode ?? null
          });

          if (nextAttempt > maxAttempts) {
            markBlocked(`verify failed after ${maxAttempts} repair attempts`, 'verify', verifyResult);
          }

          transition('REPAIRING');
          saveAll(state, queue);
          console.log(`phase VERIFYING -> REPAIRING (${currentTask.id}) attempt ${nextAttempt}/${maxAttempts}`);
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
