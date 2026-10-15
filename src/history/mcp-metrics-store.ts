import * as fs from 'fs';
import { ensureJsonFile, readJsonSync } from '../utils/json';

export interface McpUsageMetric {
  timestamp: string;
  model: string;
  modelFamily: string;
  taskType: string;
  optimizer: string;
  version: string;
  confidence: number;
  latencySeconds?: number;
  tokens?: number;
  quality?: number;
  failed?: boolean;
}

export class McpMetricsStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureFile();
  }

  private ensureFile(): void {
    ensureJsonFile(this.filePath);
  }

  private read(): McpUsageMetric[] {
    return readJsonSync(this.filePath) as McpUsageMetric[];
  }

  private write(metrics: McpUsageMetric[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(metrics, null, 2), 'utf-8');
  }

  record(metric: McpUsageMetric): void {
    const metrics = this.read();
    metrics.push(metric);
    this.write(metrics);
  }

  list(): McpUsageMetric[] {
    return this.read();
  }

  summary(): {
    totalDecisions: number;
    totalExecutions: number;
    byTaskType: Record<string, number>;
    byOptimizer: Record<string, number>;
    byModelFamily: Record<string, number>;
    avgQuality: number | null;
    failureRate: number | null;
  } {
    const metrics = this.read();
    const byTaskType: Record<string, number> = {};
    const byOptimizer: Record<string, number> = {};
    const byModelFamily: Record<string, number> = {};
    let qualitySum = 0;
    let qualityCount = 0;
    let failures = 0;
    let executions = 0;

    for (const m of metrics) {
      byTaskType[m.taskType] = (byTaskType[m.taskType] ?? 0) + 1;
      byOptimizer[m.optimizer] = (byOptimizer[m.optimizer] ?? 0) + 1;
      byModelFamily[m.modelFamily] = (byModelFamily[m.modelFamily] ?? 0) + 1;

      if (m.tokens !== undefined) {
        executions++;
        if (m.quality !== undefined) {
          qualitySum += m.quality;
          qualityCount++;
        }
        if (m.failed) {
          failures++;
        }
      }
    }

    return {
      totalDecisions: metrics.length,
      totalExecutions: executions,
      byTaskType,
      byOptimizer,
      byModelFamily,
      avgQuality: qualityCount > 0 ? qualitySum / qualityCount : null,
      failureRate: executions > 0 ? failures / executions : null,
    };
  }
}
