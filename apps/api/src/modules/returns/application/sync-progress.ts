/**
 * Progresso da rodada de sincronização de cada empresa, para a barra da Central (portado de central/progresso.py),
 * e o resultado da última rodada de cada tarefa (central/agenda.estado). Fica em memória: depois de um deploy a barra
 * some até a próxima rodada (a cada 10 min).
 */
const WEIGHTS: Record<string, number> = {
  mercado_livre: 12, refazer_ml: 12, refazer_fatura: 2, logistica_venda: 3, mediacao_origem: 3, mediacao_atuacao: 3, fatura_ml: 2,
};

export interface ProgressState {
  refazendo: string | null;
  varredura: boolean;
  rodando: boolean;
  tarefa: string | null;
  tarefas: string[];
  feitas: number;
  fracao: number;
  iniciada_em: Date | null;
  terminada_em: Date | null;
}

export interface TaskResult {
  ok: boolean;
  erro: string | null;
  em: Date;
  resultado: Record<string, unknown> | null;
}

export class SyncProgress {
  private readonly progress = new Map<string, ProgressState>();
  private readonly results = new Map<string, Record<string, TaskResult>>();

  get(tenantId: string): ProgressState {
    let p = this.progress.get(tenantId);
    if (!p) {
      p = { refazendo: null, varredura: false, rodando: false, tarefa: null, tarefas: [], feitas: 0, fracao: 0, iniciada_em: null, terminada_em: null };
      this.progress.set(tenantId, p);
    }
    return p;
  }

  start(tenantId: string, tasks: string[], opts: { sweep?: boolean; redoing?: string | null } = {}) {
    Object.assign(this.get(tenantId), {
      refazendo: opts.redoing ?? null, varredura: Boolean(opts.sweep), rodando: true, tarefas: tasks, feitas: 0, tarefa: null, fracao: 0, iniciada_em: new Date(),
    });
  }

  task(tenantId: string, name: string) {
    const p = this.get(tenantId);
    const i = p.tarefas.indexOf(name);
    Object.assign(p, { tarefa: name, feitas: i < 0 ? p.feitas : i, fracao: 0 });
  }

  partial(tenantId: string, fraction: number) {
    this.get(tenantId).fracao = Math.max(0, Math.min(1, fraction));
  }

  finish(tenantId: string) {
    const p = this.get(tenantId);
    Object.assign(p, { rodando: false, tarefa: null, feitas: p.tarefas.length, fracao: 0, terminada_em: new Date() });
  }

  percent(tenantId: string): number {
    const p = this.get(tenantId);
    if (!p.tarefas.length) return 0;
    if (!p.rodando) return 100;
    const w = p.tarefas.map((t) => WEIGHTS[t] ?? 1);
    let done = w.slice(0, p.feitas).reduce((a, b) => a + b, 0);
    if (p.feitas < w.length) done += w[p.feitas]! * p.fracao;
    return Math.round((1000 * done) / w.reduce((a, b) => a + b, 0)) / 10;
  }

  record(tenantId: string, task: string, result: { ok: boolean; erro?: string | null; resultado?: Record<string, unknown> | null }) {
    const all = this.results.get(tenantId) ?? {};
    all[task] = { ok: result.ok, erro: result.erro ?? null, em: new Date(), resultado: result.resultado ?? null };
    this.results.set(tenantId, all);
  }

  state(tenantId: string): Record<string, TaskResult> {
    return this.results.get(tenantId) ?? {};
  }
}
