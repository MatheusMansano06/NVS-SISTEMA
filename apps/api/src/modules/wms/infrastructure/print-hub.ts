import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { PrintRow } from './pg-wms-repository.js';

/** Conexão WebSocket mínima (a do @fastify/websocket). */
export interface AgentSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

interface Agent {
  tenantId: string;
  machine: string;
  socket: AgentSocket;
  printer: string | null;
  hostname: string | null;
  version: string | null;
  busyJob: string | null;
  busyAt: number;
  seenAt: number;
}

const LEASE_MS = 120_000;
const MAX_RETRIES = 3;
const OPEN = 1;

export const hashAgentKey = (key: string) => createHash('sha256').update(key).digest('hex');
export const newAgentKey = () => `nvsk_${randomBytes(20).toString('hex')}`;

/**
 * Agentes Zebra conectados (o mesmo ZebraAgent do NVS-WMS): cada um se identifica pela chave da empresa no
 * MACHINE_ID ("nvsk_….CAIXA1"). Um job por agente por vez; sem resposta em 2 min, volta para a fila (até 3x).
 * Protocolo: hello → connected; print_job → print_result; ping → pong.
 */
export class PrintHub {
  private readonly agents = new Map<string, Agent>(); // `${tenantId}|${machine}`

  constructor(private readonly db: Database) {}

  /** Empresa dona da chave (null = chave inválida). */
  async tenantForKey(machineId: string): Promise<{ tenantId: string; machine: string } | null> {
    const [key, ...rest] = machineId.split('.');
    if (!key || !/^nvsk_[a-f0-9]{40}$/.test(key)) return null;
    const { rows } = await this.db.query<{ tenant_id: string }>(
      'UPDATE wms_print_agent_keys SET last_seen_at = now() WHERE key_hash = $1 RETURNING tenant_id',
      [hashAgentKey(key)],
    );
    if (!rows[0]) return null;
    return { tenantId: rows[0].tenant_id, machine: rest.join('.') || 'MAQUINA' };
  }

  register(tenantId: string, machine: string, socket: AgentSocket) {
    const id = `${tenantId}|${machine}`;
    const prev = this.agents.get(id);
    if (prev && prev.socket !== socket) prev.socket.close(4000, 'substituído por nova conexão');
    this.agents.set(id, { tenantId, machine, socket, printer: null, hostname: null, version: null, busyJob: null, busyAt: 0, seenAt: Date.now() });
  }

  unregister(tenantId: string, machine: string, socket: AgentSocket) {
    const id = `${tenantId}|${machine}`;
    if (this.agents.get(id)?.socket === socket) this.agents.delete(id);
  }

  connected(tenantId: string) {
    return [...this.agents.values()]
      .filter((a) => a.tenantId === tenantId && a.socket.readyState === OPEN)
      .map((a) => ({ machine: a.machine, printer: a.printer, hostname: a.hostname, version: a.version }));
  }

  /** Mensagem do agente. */
  async onMessage(tenantId: string, machine: string, raw: string) {
    const agent = this.agents.get(`${tenantId}|${machine}`);
    if (!agent) return;
    agent.seenAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
    switch (msg.type) {
      case 'hello':
        agent.printer = str(msg.printer);
        agent.hostname = str(msg.hostname);
        agent.version = str(msg.agent_version);
        agent.socket.send(JSON.stringify({ type: 'connected', machine_id: machine, server_time: new Date().toISOString() }));
        await this.dispatch(tenantId);
        break;
      case 'printer_info':
        agent.printer = str(msg.printer);
        break;
      case 'ping':
        agent.socket.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'print_result': {
        const jobId = str(msg.job_id);
        if (!jobId) return;
        await this.finish(tenantId, machine, jobId, msg.status === 'ok', str(msg.job_token), str(msg.printer), str(msg.message));
        agent.busyJob = null;
        await this.dispatch(tenantId);
        break;
      }
      default:
        break;
    }
  }

  private async finish(tenantId: string, machine: string, jobId: string, ok: boolean, token: string | null, printer: string | null, message: string | null) {
    await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<PrintRow>('SELECT * FROM wms_print_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const job = rows[0];
      // resultado de outra máquina ou de um envio antigo (token diferente) é ignorado
      if (!job || (job.claimed_by && job.claimed_by !== machine) || (job.job_token && token && job.job_token !== token)) return;
      if (ok) {
        await db.query(
          `UPDATE wms_print_jobs SET status = 'PRINTED', printer_name = $2, printed_at = now(), error_msg = NULL WHERE id = $1`,
          [jobId, printer],
        );
        await db.query('UPDATE wms_items SET labels_printed = true WHERE list_id = $1 AND upper(sku) = upper($2)', [job.list_id, job.sku]);
      } else {
        await db.query(`UPDATE wms_print_jobs SET status = 'ERROR', error_msg = $2 WHERE id = $1`, [jobId, message ?? 'Erro no agente']);
      }
    });
  }

  /** Envia os jobs pendentes da empresa para agentes livres (um por agente). */
  async dispatch(tenantId: string): Promise<void> {
    const now = Date.now();
    // agente que não respondeu dentro do prazo volta a receber (o job dele é devolvido à fila abaixo)
    const free = [...this.agents.values()].filter(
      (a) => a.tenantId === tenantId && a.socket.readyState === OPEN && (!a.busyJob || now - a.busyAt > LEASE_MS),
    );
    if (!free.length) return;
    await this.db.withTenant(tenantId, async (db) => {
      // devolve à fila o que ficou preso sem resposta
      await db.query(
        `UPDATE wms_print_jobs SET status = CASE WHEN retry_count + 1 >= $1 THEN 'ERROR' ELSE 'PENDING' END,
                retry_count = retry_count + 1, claimed_by = NULL,
                error_msg = CASE WHEN retry_count + 1 >= $1 THEN 'O agente não respondeu' ELSE error_msg END
          WHERE status = 'PRINTING' AND started_at < now() - make_interval(secs => $2)`,
        [MAX_RETRIES, LEASE_MS / 1000],
      );
      for (const agent of free) {
        const token = randomBytes(12).toString('hex');
        const { rows } = await db.query<PrintRow>(
          `UPDATE wms_print_jobs SET status = 'PRINTING', claimed_by = $1, job_token = $2, started_at = now()
            WHERE id = (SELECT id FROM wms_print_jobs WHERE status = 'PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *`,
          [agent.machine, token],
        );
        const job = rows[0];
        if (!job) break;
        agent.busyJob = job.id;
        agent.busyAt = Date.now();
        agent.socket.send(
          JSON.stringify({ type: 'print_job', id: job.id, job_id: job.id, sku: job.sku, zpl_content: job.zpl, job_token: token }),
        );
      }
    });
  }
}
