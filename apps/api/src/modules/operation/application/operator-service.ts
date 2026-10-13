import {
  DEFAULT_PIN,
  PIN_LOCK_MINUTES,
  PIN_MAX_ATTEMPTS,
  areaAllows,
  type OperatorDto,
  type TeamDto,
  type TeamMemberInput,
  type TeamMode,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { hashPassword, verifyPassword } from '../../../shared/infrastructure/password.js';
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../../shared/kernel/errors.js';
import type { OperatorRow, PgOperatorRepository } from '../infrastructure/pg-operator-repository.js';

const toDto = (r: OperatorRow): OperatorDto => ({
  id: r.id,
  name: r.name,
  area: r.area,
  master: r.is_master,
  active: r.is_active,
  defaultPin: r.must_change_pin,
  locked: r.locked_until !== null && r.locked_until.getTime() > Date.now(),
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

const duplicate = (err: unknown) =>
  (err as { code?: string }).code === '23505' ? new AppError('Já existe uma pessoa ativa com esse nome.', 'CONFLICT', 409) : err;

/** Equipe da empresa: entra por nome + PIN de 4 dígitos na Análise e/ou na Operação; MASTER cadastra. */
export class OperatorService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgOperatorRepository,
  ) {}

  async list(tenantId: string): Promise<OperatorDto[]> {
    return (await this.db.withTenant(tenantId, (db) => this.repo.list(db))).map(toDto);
  }

  /** Nomes para a tela de entrada; sem MASTER ativo, a conta precisa cadastrar a equipe primeiro. */
  async team(tenantId: string, tenantName: string): Promise<TeamDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const rows = await this.repo.list(db, true);
      return {
        tenant: { name: tenantName },
        setupNeeded: !rows.some((r) => r.is_master),
        members: rows.map((r) => ({ id: r.id, name: r.name, area: r.area })),
      };
    });
  }

  /** Equipe inicial (cadastro da conta ou 1º acesso). Só vale enquanto não houver MASTER ativo. */
  async setup(tenantId: string, userId: string | null, team: TeamMemberInput[], db?: Queryable): Promise<void> {
    const hash = await hashPassword(DEFAULT_PIN);
    const run = async (q: Queryable) => {
      if ((await this.repo.activeMasters(q)) > 0) throw new ForbiddenError('A equipe já foi cadastrada. Peça a um MASTER.');
      for (const m of team) await this.repo.create(q, tenantId, m, hash, userId);
    };
    try {
      await (db ? run(db) : this.db.withTenant(tenantId, run));
    } catch (err) {
      throw duplicate(err);
    }
  }

  async create(tenantId: string, m: TeamMemberInput): Promise<OperatorDto> {
    const hash = await hashPassword(DEFAULT_PIN);
    try {
      return toDto(await this.db.withTenant(tenantId, (db) => this.repo.create(db, tenantId, m, hash, null)));
    } catch (err) {
      throw duplicate(err);
    }
  }

  async update(tenantId: string, id: string, p: { name?: string; area?: TeamMemberInput['area']; master?: boolean; active?: boolean }): Promise<OperatorDto> {
    try {
      return await this.db.withTenant(tenantId, async (db) => {
        const r = await this.repo.update(db, id, p);
        if (!r) throw new NotFoundError('Pessoa não encontrada');
        if ((await this.repo.activeMasters(db)) === 0) {
          throw new AppError('A empresa precisa de pelo menos um MASTER ativo.', 'VALIDATION_ERROR', 400);
        }
        return toDto(r);
      });
    } catch (err) {
      throw duplicate(err);
    }
  }

  /** Volta o PIN para 1234 (e destrava). */
  async resetPin(tenantId: string, id: string): Promise<void> {
    const hash = await hashPassword(DEFAULT_PIN);
    await this.db.withTenant(tenantId, async (db) => {
      if (!(await this.repo.find(db, id))) throw new NotFoundError('Pessoa não encontrada');
      await this.repo.setPin(db, id, hash, true);
    });
  }

  /** Confere o PIN e se a pessoa pode entrar nesse modo. 5 erros seguidos bloqueiam por 15 minutos. */
  async login(tenantId: string, id: string, pin: string, mode: TeamMode): Promise<OperatorRow> {
    const op = await this.db.withTenant(tenantId, (db) => this.repo.find(db, id));
    if (!op || !op.is_active) throw new UnauthorizedError('Pessoa ou PIN inválido');
    if (!areaAllows(op.area, mode)) throw new ForbiddenError(`${op.name} não tem acesso a ${mode === 'analise' ? 'Análise' : 'Operação'}.`);
    if (op.locked_until && op.locked_until.getTime() > Date.now()) {
      const min = Math.ceil((op.locked_until.getTime() - Date.now()) / 60_000);
      throw new AppError(`Muitas tentativas. Tente de novo em ${min} min ou peça a um MASTER para resetar seu PIN.`, 'LOCKED', 423);
    }
    const ok = await verifyPassword(pin, op.pin_hash);
    // o registro do erro fica numa transação própria (o erro lançado não pode desfazê-lo)
    await this.db.withTenant(tenantId, (db) =>
      ok ? this.repo.loginOk(db, id) : this.repo.loginFailed(db, id, PIN_MAX_ATTEMPTS, PIN_LOCK_MINUTES),
    );
    if (!ok) throw new UnauthorizedError('PIN incorreto');
    return op;
  }

  async me(tenantId: string, id: string): Promise<OperatorRow> {
    const op = await this.db.withTenant(tenantId, (db) => this.repo.find(db, id));
    if (!op || !op.is_active) throw new UnauthorizedError('Sessão encerrada');
    return op;
  }

  async changePin(tenantId: string, id: string, current: string, next: string): Promise<OperatorRow> {
    const op = await this.me(tenantId, id);
    if (!(await verifyPassword(current, op.pin_hash))) throw new AppError('PIN atual incorreto', 'VALIDATION_ERROR', 400);
    const isDefault = next === DEFAULT_PIN;
    await this.db.withTenant(tenantId, async (db) => this.repo.setPin(db, id, await hashPassword(next), isDefault));
    return { ...op, must_change_pin: isDefault };
  }
}
