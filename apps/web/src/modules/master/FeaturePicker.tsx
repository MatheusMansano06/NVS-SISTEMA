import { TENANT_FEATURE_INFO, TENANT_FEATURES, type TenantFeature } from '@nvs/shared';

const AREAS = ['Análise', 'Anúncios', 'Operação'] as const;

/** Recursos do sistema agrupados por área, cada um com a chave de ligar/desligar. */
export function FeaturePicker({ value, onToggle, disabled }: { value: string[]; onToggle: (f: TenantFeature, on: boolean) => void; disabled?: boolean }) {
  return (
    <div className="ms-feat">
      {AREAS.map((area) => (
        <div key={area} className="ms-feat-group">
          <h3>{area}</h3>
          {TENANT_FEATURES.filter((f) => TENANT_FEATURE_INFO[f].area === area).map((f) => {
            const on = value.includes(f);
            return (
              <label key={f} className="ms-feat-item" data-on={on || undefined}>
                <span>
                  <b>{TENANT_FEATURE_INFO[f].label}</b>
                  <small>{TENANT_FEATURE_INFO[f].text}</small>
                </span>
                <span className="ads-toggle">
                  <input type="checkbox" checked={on} disabled={disabled} onChange={() => onToggle(f, !on)} />
                  <span className="ads-switch" aria-hidden="true" />
                </span>
              </label>
            );
          })}
        </div>
      ))}
      <p className="ms-muted ms-feat-base">Sempre incluídos: Dashboard, Cadastro de SKUs, Integrações e Equipe.</p>
    </div>
  );
}
