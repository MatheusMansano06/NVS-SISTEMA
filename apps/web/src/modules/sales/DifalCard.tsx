import { useState } from 'react';
import { UFS, UF_NAME, interstateRate, type DifalSettingsDto, type SalesOverviewDto, type UF } from '@nvs/shared';
import { money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { salesApi } from './sales-api';

/** DIFAL estimado do período: total, projeção, detalhe por estado e configuração da empresa. */
export function DifalCard({ data, canManage, onSaved }: { data: SalesOverviewDto; canManage: boolean; onSaved: () => void }) {
  const d = data.difal;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const share = d.interstateBase > 0 ? d.total / d.interstateBase : 0;
  const coverage = data.located.total ? data.located.orders / data.located.total : 1;

  return (
    <section className="scard difal" aria-label="DIFAL estimado">
      <header className="scard-head">
        <div>
          <h2>DIFAL estimado</h2>
          <p>
            Origem {d.settings.originUf} · {d.settings.imported ? 'produto importado (4%)' : 'produto nacional'}
          </p>
        </div>
        <div className="scard-actions">
          <button type="button" className="act" onClick={() => setOpen((v) => !v)}>{open ? 'Ocultar estados' : 'Ver por estado'}</button>
          {canManage && <button type="button" className="act" onClick={() => setEditing((v) => !v)}>Configurar</button>}
        </div>
      </header>
      <div className="difal-kpis">
        <div className="difal-main">
          <small>DIFAL das vendas localizadas</small>
          <b>{money(d.total)}</b>
          <span>{pct(share, 1)} da base interestadual ({money(d.interstateBase)})</span>
        </div>
        {d.projection !== null && (
          <div>
            <small>Projeção para o total</small>
            <b>{money(d.projection)}</b>
            <span>mesmo mix de estados sobre todo o faturamento</span>
          </div>
        )}
      </div>
      <p className="scard-note">
        {coverage < 0.999
          ? `Destino conhecido em ${data.located.orders} de ${data.located.total} vendas — o restante vai sendo completado em segundo plano. `
          : ''}
        Estimativa gerencial: não considera base dupla (LC 190/2022), FECP nem benefícios de cada estado. Confirme com o contador.
      </p>
      {open && (
        <div className="lsales-wrap">
          <table className="lsales-table">
            <thead>
              <tr><th>Estado</th><th>Vendas</th><th>Base</th><th>Interestadual</th><th>Interna</th><th>DIFAL %</th><th>DIFAL</th></tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.uf}>
                  <td title={UF_NAME[l.uf]}><b>{l.uf}</b></td>
                  <td>{l.orders}</td>
                  <td>{money(l.base)}</td>
                  <td>{l.uf === d.settings.originUf ? 'mesmo estado' : `${l.interstate}%`}</td>
                  <td>{l.internal.toLocaleString('pt-BR')}%</td>
                  <td>{l.rate.toLocaleString('pt-BR')}%</td>
                  <td>{money(l.difal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <DifalSettings
          initial={d.settings}
          present={d.lines.map((l) => l.uf)}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      )}
    </section>
  );
}

function DifalSettings({ initial, present, onSaved }: { initial: DifalSettingsDto; present: UF[]; onSaved: () => void }) {
  const [s, setS] = useState(initial);
  const [all, setAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const ufs = all || !present.length ? [...UFS] : present;

  async function save() {
    setSaving(true);
    setError('');
    try {
      await salesApi.saveDifal(s);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="difal-settings">
      <p className="ledit-hint">Vale para toda a empresa. Ajuste a alíquota interna quando um estado mudar a dele.</p>
      <div className="difal-row">
        <label className="sku-input">
          <small>Estado de origem (de onde você envia)</small>
          <span className="sku-field">
            <select value={s.originUf} onChange={(e) => setS({ ...s, originUf: e.target.value as UF })}>
              {UFS.map((u) => <option key={u} value={u}>{u} — {UF_NAME[u]}</option>)}
            </select>
          </span>
        </label>
        <label className="ledit-check">
          <input type="checkbox" checked={s.imported} onChange={(e) => setS({ ...s, imported: e.target.checked })} />
          Produto importado (interestadual de 4%)
        </label>
      </div>
      <div className="difal-rates">
        {ufs.map((u) => (
          <label key={u} className="sku-input">
            <small>{u} · inter {u === s.originUf ? '—' : `${interstateRate(s.originUf, u, s.imported)}%`}</small>
            <span className="sku-field">
              <input
                inputMode="decimal"
                value={String(s.internalRates[u]).replace('.', ',')}
                onChange={(e) => {
                  const v = Number(e.target.value.replace(',', '.'));
                  if (Number.isFinite(v)) setS({ ...s, internalRates: { ...s.internalRates, [u]: v } });
                }}
              />
              <i>%</i>
            </span>
          </label>
        ))}
      </div>
      {present.length > 0 && (
        <button type="button" className="link" onClick={() => setAll((v) => !v)}>
          {all ? 'Mostrar só os estados com vendas' : 'Mostrar todos os estados'}
        </button>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <div className="ledit-save">
        <Button type="button" loading={saving} onClick={() => void save()}>Salvar configuração</Button>
      </div>
    </div>
  );
}
