import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionRecord, Optimizer, TaskType } from '../types';

export interface HistoryStore {
  add(record: ExecutionRecord): Promise<void>;
  list(): Promise<ExecutionRecord[]>;
  query(
    model: string,
    taskType: TaskType,
    optimizer?: Optimizer,
  ): Promise<ExecutionRecord[]>;
  queryByFamily(
    family: string,
    taskType: TaskType,
    optimizer?: Optimizer,
  ): Promise<ExecutionRecord[]>;
}

export interface JsonHistoryStoreOptions {
  filePath: string;
}

export class JsonHistoryStore implements HistoryStore {
  private filePath: string;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(options: JsonHistoryStoreOptions) {
    this.filePath = options.filePath;
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  private async read(): Promise<ExecutionRecord[]> {
    const raw = await fs.promises.readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as ExecutionRecord[];
  }

  private async write(records: ExecutionRecord[]): Promise<void> {
    await fs.promises.writeFile(
      this.filePath,
      JSON.stringify(records, null, 2),
      'utf-8',
    );
  }

  async add(record: ExecutionRecord): Promise<void> {
    this.lock = this.lock.then(async () => {
      const records = await this.read();
      records.push(record);
      await this.write(records);
    });
    await this.lock;
  }

  async list(): Promise<ExecutionRecord[]> {
    return this.read();
  }

  async query(
    model: string,
    taskType: TaskType,
    optimizer?: Optimizer,
  ): Promise<ExecutionRecord[]> {
    const records = await this.read();
    return records.filter((r) => {
      const matchesModel = r.model === model;
      const matchesTask = r.taskType === taskType;
      const matchesOptimizer = optimizer === undefined || r.optimizer === optimizer;
      return matchesModel && matchesTask && matchesOptimizer;
    });
  }

  async queryByFamily(
    family: string,
    taskType: TaskType,
    optimizer?: Optimizer,
  ): Promise<ExecutionRecord[]> {
    const records = await this.read();
    return records.filter((r) => {
      const matchesFamily = r.modelFamily === family;
      const matchesTask = r.taskType === taskType;
      const matchesOptimizer = optimizer === undefined || r.optimizer === optimizer;
      return matchesFamily && matchesTask && matchesOptimizer;
    });
  }
}

export function createExecutionRecord(
  model: string,
  modelFamily: string | undefined,
  taskType: TaskType,
  optimizer: Optimizer,
  metrics: ExecutionRecord['metrics'],
  contextSnapshot: ExecutionRecord['contextSnapshot'],
): ExecutionRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    model,
    modelFamily,
    taskType,
    optimizer,
    metrics,
    contextSnapshot,
  };
}
