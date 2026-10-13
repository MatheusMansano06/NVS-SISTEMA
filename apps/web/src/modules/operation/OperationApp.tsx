import { useEffect, useState } from 'react';
import { FullRouter } from '../full/FullRouter';
import { navigate, usePath } from '../../app/router';
import { ReturnsScanView } from '../returns/ReturnsViews';
import '../returns/returns.css';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../../shared/ui/Modal';
import { PinChange } from './PinChange';
import { usePerson } from './PersonContext';
import { TeamManager } from './TeamManager';
import './operation.css';

/** Operação: as funções da expedição entram aqui (todos da Operação veem o mesmo). */
export function OperationApp() {
  const ctx = usePerson()!;
  const { session } = useAuth();
  const me = ctx.person.person;
  const [view, setView] = useState<'home' | 'pin'>('home');
  const [team, setTeam] = useState(false);
  const path = usePath();
  const onReturns = path.startsWith('/op/devolucoes');
  // a Operação abre direto no painel de separação da Supervisão Full
  useEffect(() => {
    if (!window.location.pathname.startsWith('/op')) navigate('/op');
  }, []);

  return (
    <div className="station">
      <header className="station-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" height="40" />
        <span className="station-tag">Operação · {session?.tenant.name}</span>
        <nav className="seg op-switch" aria-label="Área da operação">
          <button type="button" role="tab" aria-checked={!onReturns} onClick={() => navigate('/op')}>📦 Supervisão Full</button>
          <button type="button" role="tab" aria-checked={onReturns} onClick={() => navigate('/op/devolucoes')}>↩︎ Devoluções</button>
        </nav>
        <span className="station-user">
          <b>{me.name}</b>
          {me.master && <button type="button" className="act" onClick={() => setTeam(true)}>Equipe</button>}
          <button type="button" className="act" onClick={() => setView('pin')}>Trocar PIN</button>
          <button type="button" className="act" onClick={ctx.switchPerson}>Sair</button>
        </span>
      </header>
      <main className="station-main">
        {view === 'pin' ? (
          <PinChange person={ctx.person} onCancel={() => setView('home')} onDone={(p) => { ctx.update(p); setView('home'); }} />
        ) : (
          <div className="op-full">{onReturns ? <div className="skus full"><ReturnsScanView /></div> : <FullRouter mode="operacao" />}</div>
        )}
      </main>
      <Modal open={team} onClose={() => setTeam(false)} label="Equipe" wide>
        <h2 className="team-modal-title">Equipe</h2>
        <TeamManager meId={me.id} />
      </Modal>
    </div>
  );
}
