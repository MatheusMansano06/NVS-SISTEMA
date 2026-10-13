// Runner de migrations SQL puro: aplica database/migrations/*.sql em ordem, uma transação por arquivo.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const command = process.argv[2] ?? 'up';
// Migrations podem rodar com um usuário privilegiado (MIGRATION_DATABASE_URL) e a aplicação
// com um usuário restrito (APP_DB_ROLE), que não ignora o Row Level Security.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const appRole = process.env.APP_DB_ROLE;
const appPassword = process.env.APP_DB_PASSWORD;
if (!url) {
  console.error('DATABASE_URL não definida');
  process.exit(1);
}
if (appRole && !/^[a-z_][a-z0-9_]*$/.test(appRole)) {
  console.error('APP_DB_ROLE inválido');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000, application_name: 'nvs-migrate' });
console.log('Migrations: conectando ao banco…');
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map(
    (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Migration ${file} foi alterada após aplicada`);
      if (command === 'status') console.log(`✔ ${file}`);
      continue;
    }
    if (command === 'status') {
      console.log(`… ${file} (pendente)`);
      continue;
    }
    console.log(`… aplicando ${file}`);
    // Uma tentativa anterior desta mesma migration pode ter ficado órfã no banco (container encerrado
    // no meio do deploy): ela segura a fila de locks da tabela e trava a aplicação. Encerra só essas.
    const orphans = await client.query(
      `SELECT pg_terminate_backend(pid) AS killed, pid FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND datname = current_database()
          AND (application_name = 'nvs-migrate' OR left(query, 300) = left($1, 300))`,
      [sql],
    );
    if (orphans.rowCount) console.log(`  encerradas ${orphans.rowCount} sessão(ões) órfã(s) desta migration`);
    // ALTER TABLE espera o lock da tabela; com a versão anterior ainda no ar (notificações, sync) isso
    // pode demorar. Em vez de travar o deploy (e enfileirar as consultas da app atrás dele), desiste
    // rápido e tenta de novo. Esgotou: sai com erro e o deploy falha sem derrubar a versão no ar.
    for (let attempt = 1; ; attempt++) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        console.log(`▶ aplicada ${file}`);
        break;
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code !== '55P03' || attempt >= 12) throw err; // 55P03 = lock_not_available
        console.log(`  tabela ocupada, nova tentativa (${attempt}/12)`);
        await sleep(2000 * attempt);
      }
    }
  }
  if (command === 'up' && appRole && appPassword) {
    // papel da aplicação: só DML, sem superusuário e sem BYPASSRLS
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole])).rowCount;
    const pw = client.escapeLiteral(appPassword);
    await client.query(
      exists
        ? `ALTER ROLE ${appRole} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`
        : `CREATE ROLE ${appRole} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
    await client.query(`REVOKE ALL ON schema_migrations FROM ${appRole}`);
    console.log(`Papel ${appRole} pronto (sem privilégios de administrador).`);
  }
  if (command === 'up') console.log('Migrations em dia.');
} finally {
  await client.end();
}
