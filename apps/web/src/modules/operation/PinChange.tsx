import { useState } from 'react';
import type { PersonSessionDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { PinPad } from './PinPad';
import { teamApi } from './operation-api';

/** Trocar o PIN: atual → novo → confirmar. Opcional (quem quiser pode ficar com 1234). */
export function PinChange({ person, onDone, onCancel }: { person: PersonSessionDto; onDone: (p: PersonSessionDto) => void; onCancel: () => void }) {
  const [step, setStep] = useState<'current' | 'next' | 'confirm'>(person.person.defaultPin ? 'next' : 'current');
  const [current, setCurrent] = useState(person.person.defaultPin ? '1234' : '');
  const [next, setNext] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(confirmed: string) {
    setBusy(true);
    setError('');
    try {
      onDone(await teamApi.changePin(current, confirmed));
    } catch (err) {
      setError(err instanceof ApiError ? Object.values(err.fieldErrors).flat()[0] ?? err.message : 'Não foi possível salvar.');
      setStep(person.person.defaultPin ? 'next' : 'current');
      setNext('');
    } finally {
      setPin('');
      setBusy(false);
    }
  }

  const title = step === 'current' ? 'Seu PIN atual' : step === 'next' ? 'Novo PIN' : 'Confirme o novo PIN';
  return (
    <section className="station-pin">
      <button type="button" className="link" onClick={onCancel}>‹ Agora não</button>
      <h1>{title}</h1>
      <p>{step === 'next' ? 'Escolha 4 números que só você saiba (sem repetir tudo igual).' : ' '}</p>
      <PinPad
        key={step}
        value={pin}
        onChange={setPin}
        disabled={busy}
        error={Boolean(error)}
        onComplete={(v) => {
          setPin('');
          setError('');
          if (step === 'current') {
            setCurrent(v);
            setStep('next');
          } else if (step === 'next') {
            setNext(v);
            setStep('confirm');
          } else if (v !== next) {
            setError('Os PINs não conferem. Digite o novo de novo.');
            setStep('next');
          } else {
            void save(v);
          }
        }}
      />
      {error && <p className="banner banner-error" role="alert">{error}</p>}
    </section>
  );
}
