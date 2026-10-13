import { useEffect, useState, type FormEvent } from 'react';
import { TEAM_AREAS, TEAM_AREA_LABELS, type OperatorDto, type TeamMemberInput } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { emptyMember } from './TeamRows';
import { teamApi } from './operation-api';
import './operation.css';

/** Cadastro da equipe (só MASTER): usado na Análise (página Equipe) e na Operação. */
export function TeamManager({ meId }: { meId: string }) {
  const [items, setItems] = useState<OperatorDto[] | null>(null);
  const [form, setForm] = useState<TeamMemberInput>(emptyMember());
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () =>
    teamApi
      .list()
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar.'));
  useEffect(() => void load(), []);

  const say = (t: string) => {
    setMsg(t);
    window.setTimeout(() => setMsg((m) => (m === t ? '' : m)), 5000);
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? Object.values(err.fieldErrors).flat()[0] ?? err.message : 'Não foi possível concluir.');

  async function add(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const op = await teamApi.create({ ...form, name: form.name.trim() });
      setForm(emptyMember());
      say(`${op.name} cadastrado. PIN inicial: 1234.`);
      void load();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    try {
      await fn();
      say(ok);
      void load();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="team-manager">
      <form className="op-add" onSubmit={add}>
        <label className="sku-input">
          <small>Nome</small>
          <span className="sku-field"><input value={form.name} maxLength={60} placeholder="Ex.: João" onChange={(e) => setForm({ ...form, name: e.target.value })} /></span>
        </label>
        <label className="sku-input op-area">
          <small>Função</small>
          <span className="sku-field">
            <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value as TeamMemberInput['area'] })}>
              {TEAM_AREAS.map((a) => <option key={a} value={a}>{TEAM_AREA_LABELS[a]}</option>)}
            </select>
          </span>
        </label>
        <label className="team-master">
          <input type="checkbox" checked={form.master} onChange={(e) => setForm({ ...form, master: e.target.checked })} /> MASTER
        </label>
        <Button type="submit" loading={saving} disabled={!form.name.trim()}>Cadastrar</Button>
      </form>
      {msg && <p className="banner banner-ok" role="status">{msg}</p>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <ul className="op-list">
        {items?.map((o) => (
          <li key={o.id} data-off={!o.active || undefined}>
            <span className="station-avatar" aria-hidden="true">{o.name.charAt(0).toUpperCase()}</span>
            <div>
              <strong>
                {o.name} {o.master && <span className="tag tag-master">MASTER</span>} {o.id === meId && <small>(você)</small>}
              </strong>
              <small>
                {!o.active ? 'Desativado' : o.locked ? 'Bloqueado por PIN errado' : o.defaultPin ? 'Usa o PIN 1234' : 'PIN próprio'}
                {o.lastLoginAt ? ` · último acesso ${new Date(o.lastLoginAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ' · nunca entrou'}
              </small>
            </div>
            <span className="op-actions">
              {o.active && (
                <select
                  className="op-area-select"
                  aria-label={`Função de ${o.name}`}
                  value={o.area}
                  onChange={(e) => void act(() => teamApi.update(o.id, { area: e.target.value as TeamMemberInput['area'] }), `${o.name} agora: ${TEAM_AREA_LABELS[e.target.value as TeamMemberInput['area']]}.`)}
                >
                  {TEAM_AREAS.map((a) => <option key={a} value={a}>{TEAM_AREA_LABELS[a]}</option>)}
                </select>
              )}
              {o.active && (
                <button type="button" className="act" onClick={() => void act(() => teamApi.update(o.id, { master: !o.master }), o.master ? `${o.name} não é mais MASTER.` : `${o.name} agora é MASTER.`)}>
                  {o.master ? 'Tirar MASTER' : 'Tornar MASTER'}
                </button>
              )}
              {o.active && !o.defaultPin && (
                <button type="button" className="act" onClick={() => window.confirm(`Voltar o PIN de ${o.name} para 1234?`) && void act(() => teamApi.resetPin(o.id), `PIN de ${o.name} voltou para 1234.`)}>
                  Resetar PIN
                </button>
              )}
              {o.active && o.locked && o.defaultPin && (
                <button type="button" className="act" onClick={() => void act(() => teamApi.resetPin(o.id), `${o.name} desbloqueado.`)}>Desbloquear</button>
              )}
              {o.id !== meId && (
                <button
                  type="button"
                  className={o.active ? 'act act-danger' : 'act'}
                  onClick={() => void act(() => teamApi.update(o.id, { active: !o.active }), o.active ? `${o.name} desativado.` : `${o.name} reativado.`)}
                >
                  {o.active ? 'Desativar' : 'Reativar'}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
