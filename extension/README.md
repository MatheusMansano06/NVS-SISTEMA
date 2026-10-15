# Extensão NVS — Estudo de Viabilidade

Extensão do Chrome que mostra, nas páginas do Mercado Livre, os dados de cada anúncio:

- **Na busca e nas listas**: etiqueta em cada anúncio com data de criação (e dias de vida), vendas e média por dia,
  catálogo/tradicional, Clássico/Premium e Full. Clique na etiqueta para ver as visitas dos últimos 6 meses.
- **Na página do anúncio**: painel fixo no canto com todos os dados e o gráfico de visitas.

Os dados vêm da API do NVS (`/api/v1/ml/viabilidade`), com o token da conta ML conectada da empresa.
A extensão não guarda senha nem token: usa o login do NVS feito no mesmo navegador.

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions` no Chrome.
2. Ligue **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha esta pasta `extension/`.
4. Fixe o ícone da extensão na barra (ícone de quebra-cabeça → alfinete).

## Usar

1. Entre no NVS (`https://nvs-app-production.up.railway.app`) neste mesmo Chrome.
2. O recurso **Estudo de Viabilidade** precisa estar liberado para a empresa no Painel Master.
3. Pesquise qualquer coisa no Mercado Livre: as etiquetas aparecem sozinhas.
4. O ícone da extensão mostra se você está conectado. Lá dá para trocar o endereço do NVS
   (só funciona com os endereços do `host_permissions` do `manifest.json`).

## Atualizar

Depois de alterar os arquivos, clique em **recarregar** (↻) no card da extensão em `chrome://extensions`
e recarregue a página do Mercado Livre.
