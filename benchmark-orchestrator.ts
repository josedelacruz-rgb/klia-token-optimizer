BENCHMARK MAIN SCRIPT
====================

This is the main orchestrator for the Klia Token Optimizer benchmark.
It compares BASELINE vs OPTIMIZED modes across 12 representative tasks.

Key design decisions:
- Klia router is ACTIVE in both modes; difference is which optimizer is selected
- BASELINE mode: router forced to select BASELINE optimizer
- OPTIMIZED mode: router selects based on task type + accumulated history
- Fresh history files per condition to avoid contamination
- Metrics collected from both CLI output and exported JSON data

Usage: npx tsx benchmark-orchestrator.ts [--repetitions N] [--tasks T1,T2,...] [--models glm-5.2]

Output: benchmark/ directory with per-experiment data and reports.