import { useEffect, useState, type FormEvent } from 'react';
import type { TaxRateDto } from '@nvs/shared';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/http';
import { skusApi } from './skus-api';

const fmtDate = (iso: string) => (iso === '1900-01-01' ? 'todo o histórico' : new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR'));

/** Alíquota de imposto da empresa: um valor só, vale para todas as vendas (com vigência). */
export function TaxRateCard() {
  const [current, setCurrent] = useState<TaxRateDto | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    skusApi
      .taxRate()
      .then((t) => {
        setCurrent(t);
        setValue(t.ratePct === null ? '' : String(t.ratePct).replace('.', ','));
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(value.replace('%', '').replace(',', '.').trim());
    if (!value.trim() || !Number.isFinite(n) || n < 0 || n > 100) return setMsg({ ok: false, text: 'Informe uma alíquota entre 0 e 100%.' });
    setBusy(true);
    setMsg(null);
    try {
      const t = await skusApi.setTaxRate(n);
      setCurrent(t);
      setMsg({ ok: true, text: `Alíquota de ${String(n).replace('.', ',')}% aplicada (vale desde ${fmtDate(t.vigenteDesde!)}).` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Não foi possível salvar.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="taxrate" data-missing={current?.ratePct === null || undefined} aria-label="Alíquota de imposto">
      <span className="taxrate-icon" aria-hidden="true">%</span>
      <div className="taxrate-text">
        <strong>Alíquota de imposto sobre as vendas</strong>
        <small>
          {current?.ratePct === null
            ? 'Ainda não definida. É o imposto que a empresa paga ao governo e vale para todos os produtos.'
            : `Vale para todos os produtos${current?.vigenteDesde ? ` · em vigor desde ${fmtDate(current.vigenteDesde)}` : ''}. Mudanças valem a partir do dia em que forem feitas.`}
        </small>
        {msg && <small style={{ color: msg.ok ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }} role="status">{msg.text}</small>}
      </div>
      <form onSubmit={(e) => void submit(e)}>
        <span className="sku-field">
          <input inputMode="decimal" placeholder="Ex.: 9" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Alíquota %" />
          <i>%</i>
        </span>
        <Button type="submit" loading={busy}>Salvar</Button>
      </form>
    </section>
  );
}
