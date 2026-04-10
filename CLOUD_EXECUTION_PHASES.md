# Cloud Execution Phase Boundary

> **Purpose:** This document defines the phase boundary between MVP (ship first)
> and Phase 2+ modules in `src/cloud/`. It is the source of truth for code
> review scope, test partitioning, and incremental shipping.

---

## Phase Summary

| Phase | Scope IDs | Goal |
|-------|-----------|------|
| **MVP** | A1–A4, B1–B6, E1–E4 | End-to-end cloud execution: dispatch → provision → run → callback → teardown |
| **Phase 2** | P2-1 to P2-5 | Explicit cancel, retry/replay, stuck-task reconciler, concurrency limiter, history |
| **Phase 3** | P3-1, P3-2 | Enhanced runtime detail views, rerun-from-snapshot |

---

## Module Classification

### MVP Modules (ship first)

| Module | Scope | Description |
|--------|-------|-------------|
| `cloud-execution-lifecycle.ts` | A1 | State machine, transitions, validators |
| `cloud-execution-persistence.ts` | A2 | Event/execution store (core fields) |
| `cloud-execution-orchestrator.ts` | A3 | Lifecycle worker (core paths only) |
| `cloud-callback-handler.ts` | A4 | Callback HTTP handler + signature verification |
| `cloud-callback-ingestion.ts` | B4 | Callback payload parsing + dedupe |
| `cloud-terminal-reconciliation.ts` | B5 | Terminal callback → lifecycle reconciliation |
| `cloud-instance-client.ts` | B1 | Cloud-platform instance CRUD client |
| `cloud-readiness-poller.ts` | B2 | Instance readiness polling loop |
| `cloud-run-client.ts` | B3 | `/run` invocation client |
| `cloud-task-prompt.ts` | B6 | Prompt composition + hashing |
| `cloud-execution-dispatch.ts` | B6 | Execution path routing (local vs cloud) |
| `cloud-agent-feature-flag.ts` | B3 | Feature flag + allowlist evaluation |
| `cloud-instance-state-mapping.ts` | B5 | Cloud state → Kanban phase mapping |

### Phase 2 Modules

| Module | Scope | Description |
|--------|-------|-------------|
| `cloud-execution-cancel.ts` | P2-1 | Explicit cancel flow with actor audit |
| `cloud-execution-retry-replay.ts` | P2-2 | Retry and replay flows |
| `cloud-stuck-task-reconciler.ts` | P2-3 | Stuck-task detection + lease-based recovery |
| `cloud-concurrency-limiter.ts` | P2-4 | Per-org concurrency admission control |
| `cloud-execution-timeline.ts` | P2-5 | Rich execution history + timeline queries |

### Phase 3 Modules

| Module | Scope | Description |
|--------|-------|-------------|
| `cloud-remote-execution-detail.ts` | P3-1 | Enhanced runtime detail view assembly |
| `cloud-debug-preserve-visibility.ts` | P3-1 | Debug-preserve UX surfacing |
| `cloud-execution-rerun-snapshot.ts` | P3-2 | Rerun-from-snapshot with pinned context |

---

## Shared Module Phase Boundaries

### `cloud-execution-persistence.ts` (A2)

**MVP fields** in `persistedTaskExecutionSchema`:
`executionId`, `taskId`, `attemptNumber`, `instanceId`, `executionMode`,
`createdAt`, `startedAt`, `completedAt`, `terminalState`, `resultSummary`,
`remoteMetadata`.

**Phase 2+ fields** (all `.optional()`, unused by MVP code paths):
`trigger` (P2-2), `triggerMetadata` (P2-2), `errorDetails`, `hostname`,
`cloudState`, `promptHash`, `promptVersion`, `branchIntent` (P2-2/P3-2),
`worktreeIntent` (P2-2/P3-2), `startingCommitSha` (P2-2/P3-2),
`durationSeconds` (P2-5), `tokenUsage` (P2-5), `teardownDecision`,
`teardownCompletedAt`.

**MVP code must not read or depend on Phase 2+ fields.**

### `cloud-execution-orchestrator.ts` (A3)

**Phase 2+ extension point:**
`ConcurrencyLimiterExtension` interface — optional ctor param; when `null`,
all tasks are admitted from `queued` immediately (MVP behavior).
No Phase 2+ modules are imported. Phase 2 injects `OrgConcurrencyLimiter`.

### API Contract (`src/core/api-contract.ts`)

**MVP exports:** `CloudExecutionState`, `cloudExecutionStateSchema`

**Phase 2+ exports (gated by dynamic import in runtime-api.ts):**
`TaskRemoteExecutionDetail*` (P3-1), `ExecutionTimeline*` (P2-5),
`ExecutionSummary*` (P2-5).

### Runtime API (`src/trpc/runtime-api.ts`)

**Phase 2+ handlers (dynamic `import()`, no bundle impact on MVP):**
`getTaskRemoteExecutionDetail` (P3-1), `getCloudExecutionTimeline` (P2-5),
`getCloudExecutionSummary` (P2-5).

---

## Test Phase Separation

### MVP Tests

```sh
npx vitest run test/runtime/cloud --testPathPattern='(lifecycle|persistence|orchestrator|dispatch|feature-flag|instance-client|instance-state-mapping|readiness-poller|run-client|task-prompt|callback-ingestion|terminal-reconciliation|teardown)'
```

MVP test files: `cloud-execution-lifecycle.test.ts`, `cloud-execution-persistence.test.ts`,
`cloud-execution-orchestrator.test.ts`, `cloud-execution-teardown.test.ts`,
`cloud-callback-ingestion.test.ts`, `cloud-terminal-reconciliation.test.ts`,
`cloud-instance-client.test.ts`, `cloud-instance-state-mapping.test.ts`,
`cloud-readiness-poller.test.ts`, `cloud-run-client.test.ts`,
`cloud-task-prompt.test.ts`, `cloud-execution-dispatch.test.ts`,
`cloud-agent-feature-flag.test.ts`.

### Phase 2+ Tests

Unit: `cloud-execution-cancel.test.ts` (P2-1), `cloud-execution-retry-replay.test.ts` (P2-2),
`cloud-stuck-task-reconciler.test.ts` (P2-3), `cloud-concurrency-limiter.test.ts` (P2-4),
`cloud-execution-timeline.test.ts` (P2-5), `cloud-remote-execution-detail.test.ts` (P3-1),
`cloud-execution-detail-view.test.ts` (P3-1), `cloud-debug-preserve-visibility.test.ts` (P3-1),
`cloud-execution-rerun-snapshot.test.ts` (P3-2).

E2E: All `cloud-e2e-*.test.ts` files are Phase 2+.

Web-UI: `cloud-execution-detail-panel.test.tsx` (P3-1).

---

## Extension Point Contract

| Extension Point | MVP Behavior | Phase 2+ |
|----------------|--------------|----------|
| `ConcurrencyLimiterExtension` | `null` → all admitted | `OrgConcurrencyLimiter` |
| Persistence Phase 2 fields | Ignored (`.optional()`) | Written by Phase 2 modules |
| API contract Phase 2 exports | Not imported | Dynamic import in runtime-api |

---

## How to Produce a Clean MVP PR

1. Cherry-pick or filter to commits A1–A4, B1–B6, E1–E4 only.
2. Exclude all Phase 2+ source files listed above.
3. Keep `ConcurrencyLimiterExtension` interface in orchestrator (extension point).
4. Remove Phase 2+ re-exports from `api-contract.ts`.
5. Remove Phase 2+ handler implementations from `runtime-api.ts`.
6. Run MVP tests only (see command above).

*Last updated: 2026-04-10 — commit boundary: cloud-execution-phase2 branch*
