import { ApiError } from '../../shared/http';

const isSafari = () => /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

/**
 * Impressão pelo navegador: baixa o PDF das etiquetas (já no tamanho da etiqueta) e abre a janela de impressão
 * num iframe oculto. No Safari, que não imprime PDF dentro de iframe, abre o PDF numa aba nova.
 */
export async function printPdf(url: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Tente novamente.', 0, 'NETWORK');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    throw new ApiError(body?.error?.message ?? 'Não foi possível gerar as etiquetas.', res.status, body?.error?.code ?? 'UNKNOWN');
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  if (isSafari()) {
    window.open(blobUrl, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return;
  }
  document.querySelectorAll('iframe[data-nvs-print]').forEach((f) => f.remove());
  const frame = document.createElement('iframe');
  frame.dataset.nvsPrint = '1';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  frame.src = blobUrl;
  await new Promise<void>((resolve) => {
    frame.onload = () => {
      // o visualizador de PDF do navegador precisa de um instante depois do load
      window.setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          window.open(blobUrl, '_blank', 'noopener');
        }
        resolve();
      }, 300);
    };
    document.body.appendChild(frame);
  });
  // limpa depois (a janela de impressão já leu o PDF)
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
}
