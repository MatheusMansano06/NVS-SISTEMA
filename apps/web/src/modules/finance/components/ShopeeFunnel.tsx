import { useEffect, useState } from 'react';
import type { ShopeeFunnelDto } from '@nvs/shared';
import { int, money, pct } from '../../../shared/format';
import { shopeeApi } from '../../shopee/shopee-api';

/**
 * Funil do Seller Center: "Pedido Pago" (o que vira venda, pela data do pagamento) × "Pedido Feito" (intenção de
 * compra, pela data de criação, inclusive os nunca pagos). Mostra quanto a mais seria vendido se 100% fosse pago.
 */
export function ShopeeFunnel({ from, to, accountId, version }: { from: string; to: string; accountId?: string; version: number }) {
  const [data, setData] = useState<ShopeeFunnelDto | null>(null);
  useEffect(() => {
    let alive = true;
    shopeeApi
      .funnel(from, to, accountId)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [from, to, accountId, version]);

  if (!data || data.feitos.pedidos === 0) return null;
  const { pagos, feitos } = data;
  const conv = feitos.valor > 0 ? Math.min(1, pagos.valor / feitos.valor) : 0;
  const gap = Math.max(0, feitos.valor - pagos.valor);
  const ganho = pagos.valor > 0 ? gap / pagos.valor : null;

  return (
    <section className="fin-card shopee-funnel" aria-label="Pedido pago e pedido feito na Shopee">
      <span className="fin-label">Pedido pago × pedido feito</span>
      <div className="funnel-rows">
        <div>
          <span>Pedido pago</span>
          <b className="money">{money(pagos.valor)}</b>
          <small>{int(pagos.pedidos)} pedidos · pela data do pagamento</small>
        </div>
        <div className="funnel-muted">
          <span>Pedido feito</span>
          <b className="money">{money(feitos.valor)}</b>
          <small>{int(feitos.pedidos)} pedidos · intenção de compra, inclusive os não pagos</small>
        </div>
      </div>
      <div
        className="funnel-bar"
        role="img"
        aria-label={`${pct(conv, 1)} do valor dos pedidos feitos foi pago`}
        title={`${pct(conv, 1)} do valor pedido virou pagamento`}
      >
        <i style={{ width: `${conv * 100}%` }} />
      </div>
      <p className="fin-sub">
        <b>{pct(conv, 1)}</b> da intenção de compra virou pagamento.{' '}
        {gap > 0 && (
          <>
            Se 100% dos pedidos feitos fossem pagos, seriam <b className="money">+{money(gap)}</b>
            {ganho !== null && <> (<b>+{pct(ganho, 1)}</b>)</>}.
          </>
        )}
      </p>
      <p className="fin-note">Valores como no Seller Center (preço de venda dos itens). A margem acima usa o repasse de cada venda.</p>
    </section>
  );
}
