import { TENANT_FEATURE_INFO, type TenantFeature } from '@nvs/shared';
import type { ReactNode } from 'react';
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

/** Recursos liberados da empresa (sessão). */
export function useFeatures(): TenantFeature[] {
  const { session } = useAuth();
  return session?.tenant.features ?? [];
}

/** Mostra a tela só se o recurso estiver liberado para a empresa; senão, "em breve". */
export function FeatureGate({ feature, children }: { feature: TenantFeature; children: ReactNode }) {
  const ok = useFeature(feature);
  if (ok) return <>{children}</>;
  const info = TENANT_FEATURE_INFO[feature];
  return <ComingSoon title={info.label} text={`${info.text} Este recurso ainda não está liberado para a sua empresa — fale com o NVS Tech para incluir no seu plano.`} />;
}
