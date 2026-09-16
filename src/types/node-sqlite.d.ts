declare module "node:sqlite" {
  interface RunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  interface StatementSync<P extends unknown[] = unknown[]> {
    get(...params: P): Record<string, unknown> | undefined;
    all(...params: P): Record<string, unknown>[];
    run(...params: P): RunResult;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare<P extends unknown[] = unknown[]>(sql: string): StatementSync<P>;
    close(): void;
  }
}