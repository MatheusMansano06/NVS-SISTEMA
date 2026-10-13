import { useState } from 'react';
import type { Marketplace, OnboardingDto, OnboardingStep } from '@nvs/shared';
import { Button } from '../../shared/ui/Button';
import { FluidBackground } from '../../shared/ui/FluidBackground';
import { usePointerGlow } from '../../shared/ui/usePointerGlow';
import { ApiError } from '../../shared/http';
import { Confetti } from './Confetti';
import { Gertrudez } from './Gertrudez';
import { Progress } from './Progress';
import { SystemOpening } from './SystemOpening';
import { Trail } from './Trail';
import { onboardingApi } from './onboarding-api';
import { ConnectVisual } from './steps/ConnectVisual';
import { PlatformPicker } from './steps/PlatformPicker';
import { consumeMlReturn, goToMercadoLivre } from '../mercado-livre/ml-api';
import './onboarding.css';

interface Props {
  initial: OnboardingDto;
  userName: string;
  onFinish: () => void;
}

export function OnboardingPage({ initial, userName, onFinish }: Props) {
  const ref = usePointerGlow<HTMLDivElement>();
  // retorno do Mercado Livre (?ml=connected | ?ml=error): conectado avança para o final
  const [mlReturn] = useState(consumeMlReturn);
  const [step, setStep] = useState<OnboardingStep>(() => {
    if (mlReturn?.connected) return 'done';
    return initial.step === 'done' ? 'authorize' : initial.step;
  });
  const [marketplace, setMarketplace] = useState<Marketplace | null>(initial.marketplace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(mlReturn?.error ?? '');
  const [opening, setOpening] = useState(false);

  async function go(next: OnboardingStep) {
    setBusy(true);
    setError('');
    try {
      await onboardingApi.save({ step: next, marketplace: marketplace ?? undefined });
      if (next === 'done' && step === 'done') return setOpening(true); // vinheta e depois o sistema
      setStep(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  async function authorize() {
    setBusy(true);
    setError('');
    try {
      await goToMercadoLivre(); // volta em /?ml=connected (ou ?ml=error)
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? err.message : 'Não foi possível abrir o Mercado Livre. Tente novamente.');
    }
  }

  const firstName = userName.split(/[.\-_ ]/)[0] ?? '';
  const hello = firstName ? `, ${firstName.charAt(0).toUpperCase()}${firstName.slice(1)}` : '';

  if (opening) return <SystemOpening onDone={onFinish} />;

  return (
    <div className="onb" ref={ref}>
      <FluidBackground lines={false} />
      <Trail step={step} />
      {step === 'done' && <Confetti />}

      <header className="onb-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" className="onb-logo" width="120" height="55" />
        <Progress step={step} />
      </header>

      <main className="onb-stage" key={step}>
        {step === 'welcome' && (
          <Gertrudez
            message={`Oi${hello}! Seja muito bem-vindo ao sistema NVS Tech!\nEu sou a Gertrudez! Pra você que ainda não me conhece: eu fico dentro do seu grupo da mentoria, te acompanhando todos os dias.\nAgora vou te guiar nesses primeiros passos. É rapidinho, prometo!`}
          >
            <Button onClick={() => void go('platform')} loading={busy}>
              Vamos começar
            </Button>
          </Gertrudez>
        )}

        {step === 'platform' && (
          <Gertrudez message={'Primeiro, me conta: em qual plataforma você vende?\nEscolhe aí embaixo que eu cuido do resto.'}>
            <PlatformPicker value={marketplace} onChange={setMarketplace} />
            {marketplace === 'mercado_livre' && (
              <p className="onb-reaction" role="status">
                Ótima escolha! O Mercado Livre é a nossa primeira integração. 💛
              </p>
            )}
            <div className="onb-nav">
              <button type="button" className="link" onClick={() => setStep('welcome')}>
                Voltar
              </button>
              <Button onClick={() => void go('authorize')} loading={busy} disabled={!marketplace}>
                Continuar
              </Button>
            </div>
          </Gertrudez>
        )}

        {step === 'authorize' && (
          <Gertrudez
            message={
              'Agora uma parte importante!\nPara você utilizar todas as partes do nosso sistema, é necessário autorizar a NVS Tech a participar da sua trajetória dentro do Mercado Livre.'
            }
          >
            <ConnectVisual />
            <ul className="onb-perks">
              <li>Acompanhar pedidos e vendas</li>
              <li>Organizar seus anúncios</li>
              <li>Cuidar do seu financeiro</li>
            </ul>
            <div className="onb-nav">
              <button type="button" className="link" onClick={() => setStep('platform')}>
                Voltar
              </button>
              <Button onClick={() => void authorize()} loading={busy} className="btn-ml">
                {busy ? 'Abrindo o Mercado Livre…' : 'Autorizar no Mercado Livre'}
              </Button>
            </div>
            <p className="onb-note">Você será levado ao site oficial do Mercado Livre e voltará aqui em seguida.</p>
          </Gertrudez>
        )}

        {step === 'done' && (
          <Gertrudez
            mood="party"
            message={'Conta conectada! Tudo pronto: seja bem-vindo ao sistema NVS Tech!\nJá estou trazendo suas vendas do Mercado Livre — o dashboard vai se preenchendo enquanto você navega.'}
          >
            <Button onClick={() => void go('done')} loading={busy}>
              Entrar no sistema
            </Button>
          </Gertrudez>
        )}

        {error && (
          <p className="banner banner-error onb-error" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
