import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max });
  }

  /** Consulta em tabelas globais (sem RLS), ex.: tenants. */
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  /**
   * Executa `fn` numa transação com `app.tenant_id` definido: o RLS do PostgreSQL
   * garante que nenhuma consulta enxergue ou grave dados de outra empresa.
   */
  async withTenant<T>(tenantId: string, fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
