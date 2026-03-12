# Implement Rules

## Execution Order
1. PLANNING
2. IMPLEMENTING
3. VERIFYING
4. ACCEPTANCE (task gates + optional acceptance hook)
5. REPAIRING (if verify/acceptance fails)
6. VISUALIZING
7. CHECKPOINT

## Planning Behavior
- In PLANNING, review current workspace progress and adjust ops/Plan.md + ops/queue.jsonl when needed.
- Prefer minimal queue edits (split, reorder, add) and avoid touching completed tasks.

## Checkpoint Behavior
- CHECKPOINT should append timeline and create a git commit when there are staged changes.
- Default commit message is auto-generated from task metadata + staged diff summary.

## Required Checks
- lint
- typecheck
- tests
- build

## Completion Behavior
- A task is complete only when verify + acceptance gates pass.
- Queue empty enters DONE only after global acceptance gate (if configured) passes.

## Visual Deliverables
- Milestone start: generate-visual-plan
- Task complete: diff-review
- Milestone midpoint: plan-review
- Milestone end: project-recap + slides
