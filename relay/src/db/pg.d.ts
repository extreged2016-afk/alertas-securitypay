declare module "pg" {
  export class Pool {
    constructor(config?: { connectionString?: string });
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
    end(): Promise<void>;
  }
}
PYEOF