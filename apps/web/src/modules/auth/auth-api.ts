import type {
  ChangePasswordInput,
  LoginInput,
  RegisterAccountInput,
  SessionDto,
} from '@nvs/shared';
import { http } from '../../shared/http';

const base = '/api/v1/auth';

export const authApi = {
  me: () => http<SessionDto>(`${base}/me`),
  login: (input: LoginInput) => http<SessionDto>(`${base}/login`, { body: input }),
  register: (input: RegisterAccountInput) => http<{ ok: true }>(`${base}/register`, { body: input }),
  logout: () => http<void>(`${base}/logout`, { method: 'POST', body: {} }),
  forgotPassword: (email: string) => http<{ ok: true }>(`${base}/forgot-password`, { body: { email } }),
  changePassword: (input: ChangePasswordInput) =>
    http<SessionDto>(`${base}/change-password`, { body: input }),
};
