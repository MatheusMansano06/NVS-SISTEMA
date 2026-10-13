import { useState } from 'react';
import { hasPermission } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { useAuth } from '../auth/AuthContext';
import { operationApi } from './operation-api';
import './operation.css';

/** Antes de entrar: Análise (o sistema completo) ou Operação (computador da expedição). */
export function ModeSelect({ onAnalysis }: { onAnalysis: () => void }) {
  const { session, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canStation = session ? hasPermission(session.user.role, 'operators:manage') : false;

  async function operation() {
    if (!window.confirm('Usar este computador na Operação? A sessão da Análise será encerrada aqui e os operadores entram pelo nome + PIN.')) return;
    setBusy(true);
    setError('');
    try {
      await operationApi.startStation();
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar na Operação.');
      setBusy(false);
    }
  }

  return (
    <div className="mode">
      <img src="/nvs-logo.webp" alt="NVS Tech" className="mode-logo" />
      <h1>Como você vai usar agora?</h1>
      <p>{session?.tenant.name}</p>
      <div className="mode-cards">
        <button type="button" className="mode-card" onClick={onAnalysis}>
          <span className="mode-icon" aria-hidden="true">📊</span>
          <strong>Análise</strong>
          <span>Dashboard, vendas, anúncios, precificador, finanças e o cadastro dos operadores.</span>
          <em>Entrar →</em>
        </button>
        <button type="button" className="mode-card mode-op" onClick={() => void operation()} disabled={!canStation || busy}>
          <span className="mode-icon" aria-hidden="true">📦</span>
          <strong>Operação</strong>
          <span>Computador da expedição: cada operador entra com o seu nome e um PIN de 4 números.</span>
          <em>{canStation ? (busy ? 'Abrindo…' : 'Usar este computador na Operação →') : 'Sem permissão para ativar'}</em>
        </button>
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button type="button" className="link" onClick={() => void logout()}>Entrar com outra conta</button>
    </div>
  );
}
