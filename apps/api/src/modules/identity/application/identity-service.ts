import { randomUUID } from 'node:crypto';
import {
  formatCnpj,
  onlyDigits,
  type ChangePasswordInput,
  type DeleteAccountInput,
  type CreateUserInput,
  type LoginInput,
  type RegisterAccountInput,
} from '@nvs/shared';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../shared/kernel/errors.js';
import type { EventBus } from '../../../shared/kernel/event-bus.js';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { hashPassword, verifyPassword } from '../../../shared/infrastructure/password.js';
import type { Tenant, TenantDirectory } from '../../tenancy/index.js';
import type { User } from '../domain/user.js';
import type { PgUserRepository } from '../infrastructure/pg-user-repository.js';

const PG_UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === PG_UNIQUE_VIOLATION;

// Hash fictício para igualar o custo de tempo quando o usuário não existe (evita enumeração).
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

const publicUser = ({ passwordHash: _omit, ...user }: User & { passwordHash?: string }): User => user;

export class IdentityService {
  constructor(
    private readonly db: Database,
    private readonly users: PgUserRepository,
    private readonly tenants: TenantDirectory,
    private readonly events: EventBus,
  ) {}

  /**
   * Cria empresa + usuário owner. A senha provisória é o CNPJ (dígitos) e o usuário é
   * obrigado a trocá-la no primeiro acesso.
   */
  async registerAccount(
    input: RegisterAccountInput,
    /** Roda na mesma transação (ex.: criar a equipe informada no cadastro). */
    extra?: (db: Queryable, ids: { tenantId: string; userId: string }) => Promise<void>,
  ): Promise<void> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const passwordHash = await hashPassword(input.cnpj);
    try {
      await this.db.withTenant(tenantId, async (db) => {
        await db.query(
          'INSERT INTO tenants (id, name, slug, cnpj, phone) VALUES ($1, $2, $3, $4, $5)',
          [tenantId, `Empresa ${formatCnpj(input.cnpj)}`, `empresa-${input.cnpj}`, input.cnpj, input.phone],
        );
        await this.users.insert(db, {
          id: userId,
          tenantId,
          email: input.email,
          name: input.email.split('@')[0]!,
          phone: input.phone,
          role: 'owner',
          passwordHash,
          mustChangePassword: true,
        });
        await db.query('INSERT INTO login_identities (email, tenant_id, user_id) VALUES ($1, $2, $3)', [
          input.email,
          tenantId,
          userId,
        ]);
        if (extra) await extra(db, { tenantId, userId });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('Já existe uma conta com este e-mail ou CNPJ');
      }
      throw err;
    }
    this.events.publish({ type: 'account.registered', tenantId, payload: { userId } });
  }

  async authenticate(input: LoginInput): Promise<{ tenant: Tenant; user: User }> {
    const identity = await this.db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM login_identities WHERE email = $1',
      [input.email],
    );
    const tenantId = identity.rows[0]?.tenant_id;
    const tenant = tenantId ? await this.tenants.resolveById(tenantId) : null;
    const found =
      tenant && tenant.status === 'active'
        ? await this.db.withTenant(tenant.id, (db) => this.users.findByEmail(db, input.email))
        : null;

    // Senha provisória = CNPJ: aceita digitado com pontuação.
    const attempt = found?.mustChangePassword ? onlyDigits(input.password) : input.password;
    const ok = await verifyPassword(attempt, found?.passwordHash ?? DUMMY_HASH);
    if (!tenant || !found || !ok || !found.isActive) throw new UnauthorizedError('E-mail ou senha incorretos');
    return { tenant, user: publicUser(found) };
  }

  async getSession(tenantId: string, userId: string): Promise<{ tenant: Tenant; user: User }> {
    const tenant = await this.tenants.resolveById(tenantId);
    const user = await this.db.withTenant(tenantId, (db) => this.users.findById(db, userId));
    if (!tenant || !user || !user.isActive) throw new NotFoundError('Sessão inválida');
    return { tenant, user: publicUser(user) };
  }

  async changePassword(tenantId: string, userId: string, input: ChangePasswordInput): Promise<User> {
    const passwordHash = await hashPassword(input.newPassword);
    return this.db.withTenant(tenantId, async (db) => {
      const user = await this.users.findById(db, userId);
      if (!user) throw new NotFoundError('Usuário não encontrado');
      const current = user.mustChangePassword ? onlyDigits(input.currentPassword) : input.currentPassword;
      if (!(await verifyPassword(current, user.passwordHash))) {
        throw new ValidationError('Senha atual incorreta', {
          fieldErrors: { currentPassword: ['Senha atual incorreta'] },
        });
      }
      if (onlyDigits(input.newPassword) === input.newPassword) {
        throw new ValidationError('Senha fraca', {
          fieldErrors: { newPassword: ['Não use apenas números'] },
        });
      }
      await this.users.updatePassword(db, userId, passwordHash);
      return publicUser({ ...user, mustChangePassword: false });
    });
  }

  /**
   * Exclui a empresa e TODOS os seus dados (cascata no banco). Só o dono, confirmando
   * o CNPJ da empresa e a própria senha.
   */
  async deleteAccount(tenantId: string, userId: string, input: DeleteAccountInput): Promise<void> {
    const user = await this.db.withTenant(tenantId, (db) => this.users.findById(db, userId));
    if (!user) throw new NotFoundError('Usuário não encontrado');
    if (user.role !== 'owner') throw new ForbiddenError('Somente o dono pode excluir a empresa');
    const attempt = user.mustChangePassword ? onlyDigits(input.password) : input.password;
    if (!(await verifyPassword(attempt, user.passwordHash))) {
      throw new ValidationError('Senha incorreta', { fieldErrors: { password: ['Senha incorreta'] } });
    }
    const { rows } = await this.db.query<{ cnpj: string | null }>('SELECT cnpj FROM tenants WHERE id = $1', [tenantId]);
    if (!rows[0] || rows[0].cnpj !== input.cnpj) {
      throw new ValidationError('CNPJ não confere', { fieldErrors: { cnpj: ['O CNPJ não confere com o da empresa'] } });
    }
    await this.db.withTenant(tenantId, (db) => db.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
    this.events.publish({ type: 'account.deleted', tenantId, payload: { userId } });
  }

  /** Confere a senha da conta (para ações destrutivas em outros módulos, ex.: apagar o Master Data). */
  async checkPassword(tenantId: string, userId: string, password: string): Promise<boolean> {
    const user = await this.db.withTenant(tenantId, (db) => this.users.findById(db, userId));
    if (!user || !user.isActive) return false;
    const attempt = user.mustChangePassword ? onlyDigits(password) : password;
    return verifyPassword(attempt, user.passwordHash);
  }

  /** Solicitação de recuperação: resposta sempre neutra. O envio de e-mail será plugado via evento. */
  async requestPasswordReset(email: string): Promise<void> {
    const identity = await this.db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM login_identities WHERE email = $1',
      [email],
    );
    const tenantId = identity.rows[0]?.tenant_id;
    if (tenantId) {
      this.events.publish({ type: 'auth.password_reset_requested', tenantId, payload: { email } });
    }
  }

  async listUsers(tenantId: string, limit: number, offset: number): Promise<User[]> {
    const rows = await this.db.withTenant(tenantId, (db) => this.users.list(db, limit, offset));
    return rows.map(publicUser);
  }

  async createUser(tenantId: string, input: CreateUserInput): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await this.db.withTenant(tenantId, async (db) => {
        const created = await this.users.insert(db, {
          tenantId,
          email: input.email,
          name: input.name,
          role: input.role,
          passwordHash,
        });
        await db.query('INSERT INTO login_identities (email, tenant_id, user_id) VALUES ($1, $2, $3)', [
          input.email,
          tenantId,
          created.id,
        ]);
        return created;
      });
      return publicUser(user);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('E-mail já está em uso');
      throw err;
    }
  }
}
