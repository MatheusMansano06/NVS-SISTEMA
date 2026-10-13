import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardDto } from '@nvs/shared';
import { fetchDashboard, type DashboardFilters } from './dashboard-api';

/**
 * Carrega o resumo e mantém o anterior na tela enquanto o novo chega
 * (troca de filtro sem "piscar"); cancela requisições obsoletas.
 */
export function useDashboard(filters: DashboardFilters) {
  const [data, setData] = useState<DashboardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (fresh = false, silent = false) => {
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;
      if (!silent) setLoading(true);
      setError('');
      try {
        setData(await fetchDashboard(filters, { fresh, signal: ctrl.signal }));
      } catch (err) {
        if ((err as Error).name !== 'AbortError' && !silent) setError('Não foi possível carregar o resumo. Tente novamente.');
      } finally {
        if (controller.current === ctrl) setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);

  // vendas chegam em tempo real (notificações): recarrega a cada minuto com a aba visível
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false, true); // silenciosa, sem piscar a tela
    }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  return { data, loading, error, refresh: () => load(true) };
}
