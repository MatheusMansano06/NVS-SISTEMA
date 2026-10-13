import { useEffect, useState, type FormEvent } from 'react';
import type { OperatorDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { operationApi } from './operation-api';
import '../skus/skus.css';
import '../listings/listings.css';
import './operation.css';

/** Cadastro dos operadores da expedição (feito pela Análise). */
export function OperatorsPage() {
  const [items, setItems] = useState<OperatorDto[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const tour = useGuidedTour('operadores', TOURS.operadores, items !== null);

  const load = () =>
    operationApi
      .list()
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar.'));
  useEffect(() => void load(), []);

  const say = (t: string) => {
    setMsg(t);
    window.setTimeout(() => setMsg((m) => (m === t ? '' : m)), 5000);
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const op = await operationApi.create(name.trim());
      setName('');
      say(`${op.name} cadastrado. PIN inicial: 1234 (será trocado no primeiro acesso).`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? Object.values(err.fieldErrors).flat()[0] ?? err.message : 'Não foi possível cadastrar.');
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
      setError(err instanceof ApiError ? err.message : 'Não foi possível concluir.');
    }
  };

  return (
    <AppShell>
      <div className="skus operators">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Operação</p>
            <h1>Operadores</h1>
          </div>
        </header>
        <p className="ledit-hint">
          Quem trabalha na expedição entra no computador da Operação tocando no próprio nome e digitando um PIN de 4 números.
          Todo operador novo começa com o PIN <b>1234</b> e cria o seu no primeiro acesso. Para colocar um computador na
          Operação, saia e escolha “Operação” ao entrar.
        </p>
        <form className="op-add" onSubmit={add}>
          <label className="sku-input">
            <small>Nome do operador</small>
            <span className="sku-field"><input value={name} maxLength={60} placeholder="Ex.: João" onChange={(e) => setName(e.target.value)} /></span>
          </label>
          <Button type="submit" loading={saving} disabled={!name.trim()}>Cadastrar</Button>
        </form>
        {msg && <p className="banner banner-ok" role="status">{msg}</p>}
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        <ul className="op-list">
          {items?.map((o) => (
            <li key={o.id} data-off={!o.active || undefined}>
              <span className="station-avatar" aria-hidden="true">{o.name.charAt(0).toUpperCase()}</span>
              <div>
                <strong>{o.name}</strong>
                <small>
                  {!o.active ? 'Desativado' : o.locked ? 'Bloqueado por tentativas erradas' : o.mustChangePin ? 'Ainda não criou o PIN (usa 1234)' : 'PIN próprio'}
                  {o.lastLoginAt ? ` · último acesso ${new Date(o.lastLoginAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ' · nunca entrou'}
                </small>
              </div>
              <span className="op-actions">
                {o.active && (
                  <button
                    type="button"
                    className="act"
                    onClick={() => window.confirm(`Voltar o PIN de ${o.name} para 1234?`) && void act(() => operationApi.resetPin(o.id), `PIN de ${o.name} voltou para 1234.`)}
                  >
                    Resetar PIN
                  </button>
                )}
                <button
                  type="button"
                  className={o.active ? 'act act-danger' : 'act'}
                  onClick={() => void act(() => operationApi.update(o.id, { active: !o.active }), o.active ? `${o.name} desativado.` : `${o.name} reativado.`)}
                >
                  {o.active ? 'Desativar' : 'Reativar'}
                </button>
              </span>
            </li>
          ))}
          {items && !items.length && <li className="lsales-empty">Nenhum operador ainda. Cadastre o primeiro acima.</li>}
        </ul>
      </div>
      {tour.element}
    </AppShell>
  );
}
