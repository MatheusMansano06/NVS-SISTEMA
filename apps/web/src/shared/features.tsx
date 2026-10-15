import type { TenantFeature } from '@nvs/shared';
import { useAuth } from '../modules/auth/AuthContext';

/** Recurso liberado para a empresa no Painel Master? (desligado = "em breve") */
export function useFeature(f: TenantFeature): boolean {
  const { session } = useAuth();
  return Boolean(session?.tenant.features?.includes(f));
}

/** Tela de recurso ainda não liberado para a empresa. */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <section className="coming-soon">
      <img src="/gertrudez.webp" alt="" width="88" height="88" />
      <span>Em breve</span>
      <h1>{title}</h1>
      <p>{text}</p>
    </section>
  );
}
