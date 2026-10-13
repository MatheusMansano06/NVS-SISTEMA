import { DEFAULT_PIN, PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, type OperatorDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { hashPassword, verifyPassword } from '../../../shared/infrastructure/password.js';
import { AppError, NotFoundError, UnauthorizedError } from '../../../shared/kernel/errors.js';
import type { OperatorRow, PgOperatorRepository } from '../infrastructure/pg-operator-repository.js';

const toDto = (r: OperatorRow): OperatorDto => ({
  id: r.id,
  name: r.name,
  active: r.is_active,
  mustChangePin: r.must_change_pin,
  locked: r.locked_until !== null && r.locked_until.getTime() > Date.now(),
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

const duplicate = (err: unknown) =>
  (err as { code?: string }).code === '23505' ? new AppError('Já existe um operador ativo com esse nome.', 'CONFLICT', 409) : err;

/** Operadores da expedição: cadastro pela Análise e entrada por nome + PIN de 4 dígitos. */
export class OperatorService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgOperatorRepository,
  ) {}

  async list(tenantId: string): Promise<OperatorDto[]> {
    return (await this.db.withTenant(tenantId, (db) => this.repo.list(db))).map(toDto);
  }

  /** Só nomes dos ativos — o que a tela de escolha do computador da operação mostra. */
  async station(tenantId: string) {
    return (await this.db.withTenant(tenantId, (db) => this.repo.list(db, true))).map((r) => ({ id: r.id, name: r.name }));
  }

  async create(tenantId: string, userId: string, name: string): Promise<OperatorDto> {
    const hash = await hashPassword(DEFAULT_PIN);
    try {
      return toDto(await this.db.withTenant(tenantId, (db) => this.repo.create(db, tenantId, name, hash, userId)));
    } catch (err) {
      throw duplicate(err);
    }
  }

  async update(tenantId: string, id: string, p: { name?: string; active?: boolean }): Promise<OperatorDto> {
    try {
      const r = await this.db.withTenant(tenantId, (db) => this.repo.update(db, id, p));
      if (!r) throw new NotFoundError('Operador não encontrado');
      return toDto(r);
    } catch (err) {
      throw duplicate(err);
    }
  }

  /** Volta o PIN para 1234 (e destrava); o operador troca no próximo acesso. */
  async resetPin(tenantId: string, id: string): Promise<void> {
    const hash = await hashPassword(DEFAULT_PIN);
    await this.db.withTenant(tenantId, async (db) => {
      if (!(await this.repo.find(db, id))) throw new NotFoundError('Operador não encontrado');
      await this.repo.setPin(db, id, hash, true);
    });
  }

  /** Confere o PIN. 5 erros seguidos bloqueiam o operador por 15 minutos. */
  async login(tenantId: string, id: string, pin: string): Promise<OperatorRow> {
    const op = await this.db.withTenant(tenantId, (db) => this.repo.find(db, id));
    if (!op || !op.is_active) throw new UnauthorizedError('Operador ou PIN inválido');
    if (op.locked_until && op.locked_until.getTime() > Date.now()) {
      const min = Math.ceil((op.locked_until.getTime() - Date.now()) / 60_000);
      throw new AppError(`Muitas tentativas. Tente de novo em ${min} min ou peça para a Análise resetar seu PIN.`, 'LOCKED', 423);
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
    if (!op || !op.is_active) throw new UnauthorizedError('Sessão de operador encerrada');
    return op;
  }

  async changePin(tenantId: string, id: string, current: string, next: string): Promise<OperatorRow> {
    const op = await this.me(tenantId, id);
    if (!(await verifyPassword(current, op.pin_hash))) throw new AppError('PIN atual incorreto', 'VALIDATION_ERROR', 400);
    await this.db.withTenant(tenantId, async (db) => this.repo.setPin(db, id, await hashPassword(next), false));
    return { ...op, must_change_pin: false };
  }
}
