# Análise funcional — Gestor Seller (referência de produto)

Método sala limpa: só comportamento observado nas telas, em leitura. Nada de código, texto
ou API de terceiros é reaproveitado. Veredito = **recomendação**, a decisão é do dono do produto.

Limite da observação: a conta usada tem Shopee e TikTok conectados e nenhuma do Mercado Livre;
várias telas de ML apareceram vazias. Telas marcadas por eles como "beta" ou "em aprimoramento":
DRE, Conciliação, Meli Ads.

## O que sustenta o produto deles
**Produto interno (com custo) ↔ anúncio de cada marketplace ("associação").** Sem esse vínculo
não há lucro: a Vendas avisa "você tem vendas sem produto vinculado". É o centro do modelo.
Para a NVS isso é a "vinculação certa" que você pediu.

## Mapa das telas e veredito

| Área | Tela | O que faz | Veredito |
|---|---|---|---|
| Base | Produtos internos | Cadastro de SKU com custo; importa planilha | **Quero (v1)** |
| Base | Associações (por marketplace) | Importa anúncios e liga ao produto interno; filtra "não associados" | **Quero (v1)** |
| Núcleo | Dashboard | Indicadores, gráfico diário, resumo por produto, top 15 | **Quero (v1)** — já especificado |
| Núcleo | Vendas | Pedido a pedido: total, líquido, imposto, custo, custo extra, lucro, margem. Filtros: período, conta, status, logística, IDs, SKU, margem mín/máx, custos eventuais | **Quero (v1)** |
| Núcleo | Curva ABC | Classifica produtos em A, B, C e Z, com lucro e lucro pós-Ads por curva | **Quero (v1)** |
| Financeiro | DRE simplificado | Faturamento → líquido → lucro bruto → armazenamento Full → Ads → lucro pós-Ads → receita extra → despesas → lucro líquido operacional; opção de incluir custo de reembolsados; PDF | **Quero (v1)** |
| Financeiro | Categorias operacionais | Categorias de despesa e de receita | **Quero (v1)** |
| Financeiro | Movimentações operacionais | Lança custo do mês e receita extra; exporta planilha | **Quero (v1)** |
| Financeiro | Conciliação | Compara venda × repasse (pago, em transferência, agendado) e aponta "recebeu a menos/a mais" | **Quero (v2)** — alto valor, depende dos dados de pagamento do ML |
| Analítico | Resumo mensal | Indicadores por mês | **Quero (v1)** |
| Analítico | Vendas por anúncio | Unidades em 30, 60, 90 e 120 dias, com tendência (cresce, estável, cai) | **Quero (v1)** |
| Analítico | Gráficos | Anual: lucro líquido (real × estimado), unidades, vendas, faturamento, custos eventuais; exporta SVG, PNG, CSV | **Quero (v1)** |
| Analítico | Reembolsos por produto | O que voltou, por produto | **Quero (v2)** |
| Ads | Meli, Shopee, Amazon | Custo Product Ads e Brands Ads, faturamento Ads, ACOS, TACOS, ROAS | **Quero (v2)** |
| Fulfillment | Inventário Full/FBA/FBS | Unidades, custo em estoque, valor previsto de venda, só estoque baixo | **Quero (v1, só Full)** |
| Relatórios | Vendas, estoque, reembolsos, operacional | Baixa planilha por período e conta | **Quero (v1)** |
| Config | Contas | Lista contas por marketplace, com imposto por conta | **Quero (v1)** |
| Config | Gerais | Margens (excelente ≥19%, boa 11–18%, ruim ≤10%), "só vendas Full", 2FA | **Quero (v1)** |
| Config | Usuários | Sub-usuários da empresa | **Quero (v1)** |
| Config | Faturas e Upgrade | Plano e cobrança | **Depois (v3)** |
| Extra | Metas | Metas por período | **Depois (v2)** |
| Extra | Agências | Consultoria acessando várias empresas | **Depois (v3)** — abre canal de venda |
| Extra | Tutoriais / onboarding | Passo a passo inicial | **Depois (v2)** |
| Extra | Sugestões | Caixa de melhorias | **Depois (v2)**, versão simples |
| Integr. | Amazon, Magalu, Shein, TikTok, Nuvemshop, Tiny | Marketplaces e ERPs extras | **Não (v1)** — v1 só ML e Shopee |
| Extra | Amazon Avançado (beta) | Recursos específicos da Amazon | **Não** |
| Extra | Universidade, Novidades, Indique e ganhe | Conteúdo e crescimento | **Não (v1)** |

## Ideias que valem copiar como princípio
- Todo número com **estado vazio explicativo**, nunca zero solto.
- Filtro de **conta** (e de empresa) em todas as telas.
- **Exportar** gráfico e tabela (CSV) em toda tela de análise.
- Aviso honesto quando a tela é beta ou o dado ainda está em validação.
- Margem com **faixas coloridas** configuráveis por empresa.

## O que a NVS tem e eles não (diferenciais, opcionais por empresa)
Estoque próprio com baixa por separação, Central de Devoluções, Radar de Envio Full, inbound
e conferência, integração Olist.
