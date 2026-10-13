<div align="center">

<img src="docs/assets/klia-token-optimizer-banner.png" alt="Klia Token Optimizer — intelligent optimization for OpenCode" width="100%">

# Klia Token Optimizer

### Less unnecessary context. Smarter decisions. Measurable results.

[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/Tests-Vitest-6e9f18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![MCP](https://img.shields.io/badge/MCP-Integration-0a9e6a?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./package.json)

**An intelligent optimization layer for OpenCode that coordinates six strategies and uses recorded execution results to guide future decisions.**

</div>

---

## What if every task used the right strategy?

Not every coding task needs the same context or benefits from the same tool. Klia Token Optimizer helps select among different strategies based on task type, model, and available execution history.

The goal: **reduce avoidable token usage while keeping quality, failures, latency, and total cost in view.**

> Klia does not promise a universal savings percentage. It records and compares results to help identify which strategies work best in a given environment.

## What can it bring to your workflow?

<table>
<tr>
<td width="50%" valign="top">

### 🎯 Task-aware selection

The router evaluates the type of work and proposes a candidate strategy instead of always applying the same optimizer.

</td>
<td width="50%" valign="top">

### 📉 Measurable savings, not assumptions

Records tokens and other metrics to compare strategies against a baseline and distinguish savings, regressions, or neutral results.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧠 History-informed decisions

Recorded executions provide evidence to adapt selection by model and task type.

</td>
<td width="50%" valign="top">

### ⚖️ Balance between savings and quality

Evaluation can consider tokens, latency, tool costs, failures, and quality—not just token volume.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🛡️ Conservative fallback

When evidence is insufficient, the router can fall back to `BASELINE` rather than treating an unvalidated alternative as the winner.

</td>
<td width="50%" valign="top">

### 📊 Results visibility

Review statistics by model and task, compare optimizers, and separate real data from synthetic records.

</td>
</tr>
</table>

## Six coordinated strategies

| Strategy       | Potential use case                                              |
| -------------- | --------------------------------------------------------------- |
| `BASELINE`     | Comparison reference or safe fallback when evidence is missing. |
| `DCP`          | Selective context pruning or compression.                       |
| `RTK`          | Reducing noise in terminal output, commands, and logs.          |
| `CONTEXT_MODE` | Work involving large context, documentation, and indexing.      |
| `REPOMIX`      | Preparing a packaged view of a repository.                      |
| `SEMBLE`       | Semantic search to locate relevant code.                        |

Final selection depends on the rules, model, task type, and available data; no single strategy is assumed to win in every case.

## How it works

```text
OpenCode
   │
   ▼
Task classification
   │
   ▼
Rules + historical evidence + model
   │
   ▼
Optimizer selection
   │
   ▼
Execution and result recording
   │
   ▼
Statistics to guide future decisions
```

### A data-informed improvement cycle

1. **Classify** the task using signals such as the query, file count, and context size.
2. **Evaluate** candidate optimizers and the evidence available for that model and task.
3. **Select** a strategy, falling back to `BASELINE` when appropriate.
4. **Record** the available execution metrics.
5. **Compare** results to identify savings, regressions, or no improvement.

The router includes four decision-algorithm versions: from baseline rules (V0), through history-informed adaptation (V1–V2), to controlled exploration (V3).

## Measure what matters

- **Tokens:** total usage and, when available, input/output breakdown.
- **Relative savings:** comparison against the baseline for the same model/task combination.
- **Latency:** execution time.
- **Cost:** estimated or recorded cost and tool costs.
- **Quality and reliability:** quality ratings, failures, and retries.
- **Traceability:** model, task, strategy, selection rationale, and confidence.

Results depend on configuration and recorded metrics. To demonstrate real savings, compare strategies using the same model, task, repository, and quality criteria.

## Quick installation on Windows

<img src="docs/assets/Klia_Token_Optimizer_2.png" alt="Klia Token Optimizer — intelligent optimization for OpenCode" width="100%">

The repository includes a PowerShell installer to set up the router and the optimizers supported by the project.

```powershell
powershell -ExecutionPolicy Bypass -File install_klia_token_optimizer.ps1
```

The documented installer supports profiles and a dry run:

```powershell
.\install_klia_token_optimizer.ps1 -StackProfile minimo
.\install_klia_token_optimizer.ps1 -DryRun
```

> Project-listed requirements: Node.js `>= 22.5`, npm, and `uv` for tools that require it. Review the installer instructions before running it in a work environment.

## Example: request a routing decision

```bash
npm run router -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 250000
```

The output includes the selected optimizer, task type, router version, confidence, and decision rationale.

After running the task, record real metrics to contribute to the history:

```bash
npm run router -- --record-id <RECORD_ID> --tokens 9500 --latency 88 --quality 0.98
```

Query the statistics:

```bash
npm run router -- stats --model glm-5.2 --real-only
```

The values above are usage examples, not a savings promise or a universal benchmark result.

## MCP integration

El servidor expone cuatro herramientas:

| Tool               | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `route_task`       | Recommend an optimizer for a task.           |
| `record_execution` | Record an execution result.                  |
| `get_router_stats` | Query statistics and comparisons.            |
| `migrate_history`  | Migrate history to the current event schema. |

## Why Klia Token Optimizer?

Many projects focus on a specific technique: compressing context, filtering output, indexing code, or routing models. Klia takes a coordination approach: **bringing multiple strategies together in one layer and using recorded results to guide selection**.

Its value should be verified with data from the real environment. Run comparable tests and evaluate token usage, quality, latency, failures, and instrumentation overhead together.

## Project status

- Adaptive router with versions V0–V3.
- Six strategies supported by the router rules.
- Execution recording and reports by model and task.
- MCP server and CLI.
- Automated tests available in the repository.

To verify a particular installation or strategy, run the tests and perform a controlled benchmark in your environment.

## Development

```bash
npm install
npm run build
npm test
```

## Documentation

- [OpenCode usage guide](./OPENCODE_USAGE.md)
- [Installer details](./instaladores/install.md)
- [Project conventions](./AGENTS.md)

## License

ISC License. See [`package.json`](./package.json).

---

<div align="center">

**Klia Token Optimizer · Optimize. Measure. Learn from results.**

</div>
