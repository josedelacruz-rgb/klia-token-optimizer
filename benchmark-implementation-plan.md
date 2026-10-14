BENCHMARK IMPLEMENTATION PLAN
============================

Repository audited: C:\ProyectosIA\Klia-Optimizer\klia-token-optimizer
Date: 2026-10-13

## Repository Summary

### Core Components Identified

1. **Router Adaptativo** (src/router-cli.ts, src/index.ts)
   - Routes tasks to optimizers using task classification + historical evidence
   - V0-V3 decision versions
   - Fallback to BASELINE when evidence insufficient

2. **Task Classifier** (src/classifier/task-classifier.ts)
   - classifyTask() - classifies into SMALL_CODE, TERMINAL, LARGE_CONTEXT, REPOSITORY_SEARCH, MULTISTEP, REFACTOR, UNKNOWN
   - extractSignalsFromQuery() - extracts hasTerminalCommands, isRefactor, isRepositorySearch, isMultistep from query text
   - classifyContextSize() - detects LARGE_CONTEXT/LARGE_CONTEXT_EXTREME

3. **Base Rules** (src/rules/base-rules.ts)
   - BASE_RULES maps task type to candidate optimizers
   - SMALL_CODE -> [BASELINE]
   - TERMINAL -> [RTK, DCP]
   - LARGE_CONTEXT -> [SEMBLE, CONTEXT_MODE, REPOMIX]
   - REPOSITORY_SEARCH -> [CONTEXT_MODE, REPOMIX]
   - MULTISTEP -> [DCP]
   - REFACTOR -> [RTK]
   - UNKNOWN -> [BASELINE]

4. **Cost Scorer** (src/scorer/expected-cost-scorer.ts)
   - computeRecordCost() - absolute cost: tokens + latency*weight + toolingCost*weight + failurePenalty + qualityPenalty*(1-quality)
   - computeRelativeCost() - relative cost vs BASELINE for same (model, task)
   - buildCostMatrix() - groups records by model::taskType

5. **Stats Report** (src/scorer/stats-report.ts)
   - buildStatsReport() - enriched v2 report with OptimizerCell, ModelRow, ModelRow, RouterStatsReport
   - computeEventCost() - v2 equivalent of computeRecordCost
   - Reports: savingsTokens, savingsPercent, savingsUsd, verdict (AHORRO/PERDIDA/NEUTRO), winner

6. **Router Event Store** (src/history/router-event-store.ts)
   - RouterEventStore - v2 unified events (events.json)
   - decision events + execution events
   - query() with filters (model, taskType, optimizer, source, excludeSynthetic, sessionId)
   - markAllAsSynthetic() - for benchmark data
   - migrateFile() - v1 to v2 migration

7. **History Store** (src/history/history-store.ts)
   - JsonHistoryStore - v1 ExecutionRecord (history.json)
   - add(), list(), query(), queryByFamily()
   - createExecutionRecord() - builds records with id, timestamp, model, modelFamily, taskType, optimizer, metrics, contextSnapshot

8. **MCP Server** (src/mcp-server.ts)
   - 4 tools: route_task, record_execution, get_router_stats, migrate_history
   - RouteTaskSchema + RecordExecutionSchema (Zod validation)
   - RecordExecutionSchema includes: optimizer enum, tokens, inputTokens, outputTokens, latencySeconds, toolingCost, costUsd, quality, failed, retries, errorMessage, contextSizeBytesAfter, tokensPruned, actualToolCalls, routerLatencyMs, startedAt, completedAt, sessionId, projectId, source, synthetic

9. **Pricing** (src/pricing/model-pricing.ts)
   - ModelPricing: inputPerMillion, outputPerMillion (USD per 1M tokens)
   - FAMILY_PRICING, MODEL_PRICING, FALLBACK_PRICING
   - getPricing(), computeCostUsd()

10. **Discovery** (src/klia-discovery.ts)
    - detectKliaApiKey() - env var, opencode.jsonc, SNAPSHOT_MODELS
    - discoverModelsFromApi() - GET https://api.klia.tech/v1/models
    - discoverModels() - API with snapshot fallback
    - SNAPSHOT_MODELS - 26 static chat models

11. **Installer** (install_klia_token_optimizer.ps1)
    - Installs router + 5 optimizers (Semble, Context Mode, RTK, Repomix, Serena)
    - Modifies opencode.jsonc and AGENTS.md
    - Embeds routing blocks
    - Calibrates history with baseline records

### Key Types (src/types.ts)

- Optimizer: 'BASELINE' | 'DCP' | 'RTK' | 'CONTEXT_MODE' | 'REPOMIX' | 'SEMBLE'
- TaskType: 'SMALL_CODE' | 'TERMINAL' | 'LARGE_CONTEXT' | 'REPOSITORY_SEARCH' | 'MULTISTEP' | 'REFACTOR' | 'UNKNOWN'
- RouterEvent: type 'decision' | 'execution', schemaVersion 2, source, synthetic
- RouterEventExecution: inputTokens, outputTokens, totalTokens, latencySeconds, costUsd, toolingCost, quality, failed, retries, contextSizeBytesAfter, tokensPruned, actualToolCalls, routerLatencyMs, startedAt, completedAt
- RouterEventDecision: optimizer, version, confidence, reason, alternatives

## Implementation Approach

### Philosophy: "Klia Always Loaded, Strategy Differently Active"

The benchmark will operate on the principle that Klia's router is active in both modes, but the **strategy selected differs**:

- **BASELINE mode**: Router always selects BASELINE optimizer (no strategy applied)
- **OPTIMIZED mode**: Router selects optimizer based on task type + historical evidence

This approach avoids the need to globally uninstall Klia or modify OpenCode configuration, which aligns with the mission's constraint: "No desinstales globalmente herramientas ni sobrescribas la configuración personal."

### Isolation Strategy

Since we cannot easily separate Klia's hooks/MCP from OpenCode without reinstalling, we use:

1. **Separate history files** per condition (baseline-history.json vs optimized-history.json)
2. **Fresh history start** for each condition (no cross-contamination)
3. **Explicit optimizer control**: BASELINE mode forces optimizer=BASELINE; OPTIMIZED mode lets router select
4. **Verification checks**: Confirm the selected optimizer differs between modes

### When Router Selects BASELINE in OPTIMIZED Mode

The router will select BASELINE when:
- No history exists for (model, taskType) -> V0, returns BASE_RULES default
- History exists but confidence < minConfidence (0.6) or samples < minSamples (3) -> V1, fallback
- All candidates have relativeCost that doesn't beat BASELINE

For task types where BASE_RULES default is NOT BASELINE (TERMINAL->RTK, REFACTOR->RTK), the OPTIMIZED mode will select RTK by default if no history exists. To ensure meaningful comparison, we'll:
- Seed history with BASELINE records for fair comparison
- Or explicitly track when BASELINE is selected in OPTIMIZED mode

### Design of 12 Tasks

Based on the existing tareas.json and mission requirements:

| ID | Task Type | Description | Expected Optimizer (OPTIMIZED) |
|----|-----------|-------------|--------------------------------|
| T1 | SMALL_CODE | Single file, simple change | BASELINE |
| T2 | TERMINAL | CLI command, terminal output | RTK |
| T3 | LARGE_CONTEXT | Large documentation analysis | SEMBLE (first in BASE_RULES) |
| T4 | REPOSITORY_SEARCH | Search for function/pattern | CONTEXT_MODE (first in BASE_RULES) |
| T5 | MULTISTEP | Multi-step planning/refactoring | DCP |
| T6 | REFACTOR | Refactor module/responsibilities | RTK |
| T7 | ERROR_ANALYSIS | Diagnose error from messages | RTK (terminal-like) |
| T8 | DOC_ANALYSIS | Extract requirements from docs | CONTEXT_MODE |
| T9 | TESTS | Add/repair automated tests | DCP or RTK |
| T10 | CONTROL | Small task to detect Klia overhead | BASELINE |
| T11 | QUERY_COMPLEX | Complex multi-file query | LARGE_CONTEXT path |
| T12 | REPO_SETUP | Repo exploration/setup | REPOMIX |

Note: The expected optimizers are based on BASE_RULES first candidates, but actual selection depends on accumulated history.

### Metrics Collection

Per the mission requirements, collect per execution per task:

**Tokens:**
- inputTokens (prompt/entry)
- outputTokens (completion/exit)
- totalTokens = input + output
- tokensPruned (if optimizer applied)
- tokensReadFromCache, tokensWrittenToCache (if measurable)

**Calls & Steps:**
- numToolCalls (actualToolCalls)
- numMessages, numSteps
- numRetries
- numSecondaryAgents

**Latency:**
- totalExecutionTime
- timeToFirstResponse
- accumulatedModelCallTime

**Cost:**
- costUsd (if available)
- toolingCost
- estimated cost via pricing

**Quality:**
- quality score 0-1
- failed: boolean
- errorMessage if failed
- testsPassed/failed
- git diff quality

### Data Hierarchy (per mission §7)

Sources of decreasing confidence:
1. Provider usage counters (most authoritative)
2. OpenCode session statistics
3. API-local metrics if available
4. Klia's own registered metrics (may differ)
5. Tokenizer estimates (NOT presented as real)

Preference: Use provider/counter values first, then OpenCode session data, then Klia data. Document discrepancies.

### Experiment Design

- 12 tasks × 2 conditions (BASELINE, OPTIMIZED) × 5 repetitions = 120 executions
- Randomized alternated order to reduce temporal bias
- Pilot (2 tasks × 2 conditions × 3 repetitions) to verify measurement
- Per-mission: if fewer valid executions, report explicitly

### Output Structure

```
benchmark/
  manifest.json          # Experiment metadata
  environment.json       # System config, versions
  tasks/                 # Task definitions
    T1_SMALL_CODE/
      baseline/
        run-1/
          session.json
          metrics.json
          quality.json
        summary.json
      optimized/
        run-1/
          ...
    ... (per task)
  raw/                   # Original logs, unmodified JSON
  metrics/               # Computed statistics
    summary.json
    summary.csv
    tables/
      by_task.md
      global.md
  quality/               # Quality test results
  report.md              # Professional report (Spanish)
  report.html            # HTML version
  report.docx            # Word version (if possible)
  summary.json           # Machine-readable summary
  summary.csv            # Machine-readable CSV
```

### Script Entry Point

`npm run benchmark` - executes the full benchmark pipeline.

The script will be in `scripts/benchmark.ts` with subcommands or as a single orchestrating script.

## Phase Gate Checklist

Before moving to implementation, verify:

- [x] Repository audited - all key modules understood
- [x] Types, BASE_RULES, event stores understood
- [x] Installation path verified (installer modifies OpenCode config)
- [x] Synthetic test data exists in pruebas/escenarios/
- [x] Tests exist and pass (npm test)
- [ ] Benchmark script designed with proper isolation
- [ ] Task definitions created with fixtures
- [ ] Measurement instrumentation identified
- [ ] Report template defined
- [ ] Pilot execution planned

## Next Steps

1. Create benchmark script directory structure
2. Define 12 task specifications with fixtures
3. Implement the main benchmark orchestrator script
4. Implement metrics collection and analysis
5. Create pilot test (2 tasks × 2 conditions × 3 reps)
6. Verify measurement integrity
7. Run full benchmark (12 tasks × 2 conditions × 5 reps)
8. Generate reports