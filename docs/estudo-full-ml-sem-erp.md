# Estudo: Supervisão Full para mentorados só com Mercado Livre (sem ERP, sem Zebra)

Data: 15/10/2026 · Base: código atual de `apps/api/src/modules/wms`, `apps/web/src/modules/full`, `mercado-livre` e a doc oficial do ML.
Feito em 4 frentes: inbound, etiqueta/impressão, Master Data e telas/permissões.

## 1. Resumo executivo

- **O inbound já é 100% Mercado Livre**: lemos o PDF "Lista de produtos e instruções de preparação". Não há chamada a ERP.
- **A Olist só aparece no Master Data**, via CSV de EANs. Esse dado existe nos anúncios do ML: chega na nossa sincronização e é jogado fora.
- **A etiqueta é gerada por nós** (ZPL em `domain/zpl.ts`). Nem ERP nem ML fornecem etiqueta de produto Full por API.
- **O que prende o mentorado é a impressão**: ZPL + ZebraAgent no Windows + trava `PrinterGate`. Sem agente, os jobs ficam PENDING para sempre e o operador fica bloqueado.
- **Solução**: modo de impressão por empresa. No modo `navegador`, a etiqueta sai em PDF do tamanho exato e é impressa em qualquer impressora. O Master Data passa a ser montado automaticamente pelos anúncios do ML.

## 2. Como funciona hoje

```
ANÁLISE  /full/processamento: sobe PDF ──► POST /wms/inbound (só mode 'analise')
         ──► parser por posição ──► lote → listas (≤1000 un.) → itens
         ──► Master Data: SKU + Código ML (inventory_id) + EAN do PDF viram códigos bipáveis
OPERAÇÃO /op/full: PrinterGate (agente ligado + teste do dia) ──► claim da lista ──► PickingScreen
         ──► scan → item completo → print() AUTOMÁTICO (wms-service.ts:358, 433, 442, 503)
         ──► buildLabelsZpl → wms_print_jobs → PrintHub (WS /ws/zebra-agent) → ZebraAgent-WP.exe → Zebra
         ──► agente responde → labels_printed = true (print-hub.ts:121) → lista conclui sozinha
```

## 3. Inbound

### 3.1 API do ML (doc oficial)

| Existe | Não existe |
|---|---|
| `inventory_id` no item e em cada variação (`GET /items`); é o "Código ML" do PDF e da etiqueta | Endpoint para listar, criar ou detalhar envio ao Full |
| Estoque Full: `GET /inventories/{id}/stock/fulfillment` (motivos: `empty_identifier`, `invalid_identifier`…) | Download da etiqueta de produto Full (PDF/ZPL) |
| Movimentações: `/stock/fulfillment/operations/search`, `INBOUND_RECEPTION` com `inbound_id`; notificação `fbm_stock_operations` | Download do PDF de preparação |
| Reposição sugerida: `/marketplace/fbm/user-products/{id}/replenishment` | |

**Conclusão:** o PDF continua sendo a fonte do envio. A API serve para validar o PDF, montar o Master Data e, depois, conferir o que o ML recebeu.
Fontes: [envios-fulfillment](https://developers.mercadolivre.com.br/pt_br/envios-fulfillment), [reposição](https://developers.mercadolivre.com.br/pt_br/planejamento-de-reposicao-para-fulfilment), [notificações](https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes).

### 3.2 Fragilidades do parser (`domain/ml-inbound-pdf.ts`), da mais grave para a menos grave

1. **Não há PDF real do ML nos testes**: só um PDF sintético (`test/helpers/inbound-pdf.ts`). Se o ML mudar o layout, nada acusa.
2. **No ML o total não é conferido**: `declaredUnits` só é checado na Shopee (`wms-service.ts:96`). Item descartado some sem aviso. Casos de descarte: sem SKU (:80), sem quantidade (:88) e produto quebrado entre páginas (bloco fechado no fim da página, :69).
3. **Anúncio sem SKU**, o caso típico do mentorado: a regex `SKU:\s*(\S+)` (:78) pega a 1ª palavra da descrição como SKU (ex.: "KIT"). Isso contamina o Master Data e pode juntar anúncios diferentes.
4. **SKU com espaço** é cortado na 1ª palavra.
5. **Cabeçalho obrigatório**: sem o texto exato `UNIDADES` (:40) o envio inteiro é recusado.
6. **Descrição** pode absorver rodapé ou cabeçalho da página seguinte.
7. **Mesmo PDF subido 2×** cria o lote "nº2", porque não há bloqueio por `inbound_ref`.
8. **Instruções de preparo** (coluna IDENTIFICAÇÃO) são descartadas, mas poderiam ajudar o operador.

### 3.3 Ações

- Pôr 2 ou 3 PDFs reais do ML (anonimizados) em `__fixtures__` com teste golden.
- Conferir `declaredUnits` no ML e recusar ou avisar quando a soma não fechar.
- Sem SKU: usar o SKU do anúncio (pelo `inventory_id` sincronizado). Se não houver, usar o próprio Código ML como SKU.
- Manter o bloco aberto entre páginas e bloquear (ou confirmar) quando o `inbound_ref` for repetido.
- Opcional: mostrar as instruções de preparo no item.

## 4. Etiqueta e impressão

### 4.1 O ZPL atual em medidas (203 dpi)

- **Etiqueta**: ~40×25 mm, em **rolo de 2 colunas** (passo de 40 mm, ~80 mm de rolo). Quantidade ímpar sai com uma etiqueta sozinha.
- **Code128** com módulo de 0,25 mm e altura de 6,75 mm. Um Código ML de 10 caracteres ocupa ~36 mm. Cabe nos 40 mm, mas a zona de silêncio fica em ~1,9 mm, abaixo dos 2,5 mm recomendados.
- **Conteúdo**: código de barras, Código ML legível, descrição (2 linhas, caixa de 37,5 mm) e `SKU:`.
- **Tamanho oficial da etiqueta Full**: não confirmado (a ajuda do ML exige login). O mercado vende rolos "Full" de **50×25 (1 coluna)** e 40×25 / 40×20.

### 4.2 O que pressupõe o agente

- **API**:
  - `print-hub.ts` inteiro;
  - em `wms-service.ts`: `print()` (660), o auto-print (358/433/442/503), `zpl()` (698), `agentStatus` (707), `printerStatus.ready` (723), `printTest` (753), `confirmPrinter`, que exige agente (771), e `newAgentKey` (792);
  - rotas `routes.ts:131-152` e o WebSocket em `:192-211`.
- **Web**:
  - `PrinterGate.tsx` inteiro;
  - em `PickingScreen.tsx`: polling `watch()` (58-73) e `PrintZone` (317-340, com "Baixar ZPL");
  - `OperatorHome.tsx:39-47`, a trava de entrada;
  - `ProcessingView.tsx:94-300`, o instalador e a chave `nvsk_`.

### 4.3 Proposta: PDF gerado no servidor

**Escolha: PDF no servidor**, com **pdfkit + bwip-js**. Hoje não há lib de PDF nem de código de barras instalada. Motivos da escolha:
- o PDF já sai do tamanho exato da etiqueta;
- o Chrome/Edge imprime em tamanho real;
- é testável;
- gera o lote inteiro num arquivo só.

HTML com `@page` ficou descartado: o tamanho da página e as margens variam no Safari e no Firefox.

**Regras de qualidade:**
- código de barras **vetorial**, nunca PNG;
- módulo de 0,25 mm, zona de silêncio de 2,5 mm e altura de 8 a 10 mm;
- tela de orientação: "Escala 100% / Margens nenhuma", e o tamanho do papel configurado no driver (Elgin/Argox), igual ao da etiqueta.

| Formato | Página | Uso |
|---|---|---|
| `termica_1col` **(padrão mentorado)** | 50×25 mm | rolo térmico comum; mais folga para o código |
| `termica_2col` | 80×25 mm (2 por página) | quem já tem o rolo 40×25 de 2 colunas, igual ao ZPL |
| `a4_a4356` | A4, Pimaco A4356 (63,5×25,4 mm, 3×11) | quem não tem térmica. Atenção: a 6180/6181 é tamanho **Carta**, não A4. Conferir as medidas no site da Pimaco |

## 5. Master Data sem ERP

**Hoje:**
- O inbound faz `upsertProduct` e `addCode` com o Código ML e o EAN do PDF (`wms-service.ts:153-157`).
- O CSV é opcional e soma sem apagar.
- Na bipagem, código desconhecido permite `linkBarcode`.
- `no_physical_barcode` libera a separação manual.
- O CSV de exemplo do ERP já mistura GTIN com Código ML, ou seja, não traz nada que o ML não tenha.

**Dados do ML:**
- O multiget `ml-api.ts:308-318` já traz `attributes` (GTIN, SELLER_SKU) do item e das variações (`include_attributes=all`).
- `inventory_id` **não** está no filtro `attributes=`.
- `mapMlItem` (`ml-order.ts:103-142`) guarda só o SKU; GTIN e `inventory_id` são descartados.
- `listings` não tem essas colunas.

**Proposta:**
1. Incluir `inventory_id` no multiget e extrair GTIN (`GTIN`; `EAN`/`UPC` como reserva) e `inventory_id` por item e variação.
2. Criar a tabela `listing_variants(tenant_id, external_id, variation_id, sku, gtins[], inventory_id, title)`.
3. No fim de `importListings`, ou pelo botão "Gerar Master Data pelos anúncios", rodar `upsertProduct(sku, título)` + `addCode(inventory_id)` + `addCode(gtin, primário)`. São idempotentes.
4. Sem SKU: usar o `inventory_id` como chave. Sem GTIN: fica só o Código ML e sugere-se `no_physical_barcode`.
5. Efeito colateral bom: a Central de Devoluções (`central-service.ts:1063`) passa a traduzir a etiqueta Full mesmo sem inbound.

A confirmar numa conta real: anúncio de catálogo pode ter o GTIN no produto do catálogo, e não no item. O `inventory_id` só existe em anúncio que já passou pelo Full.

## 6. Telas, configuração e permissões

**Textos de agente/Zebra a tornar condicionais:**
- `OperatorHome.tsx:39-47, 143`
- `PickingScreen.tsx:324-337`
- `PrinterGate.tsx` (todo)
- `ProcessingView.tsx:99-293`
- `OperationHome.tsx:54`
- `tours.ts:152, 156, 204, 216`
- `wms-service.ts:774`

Não há menção a Olist/ERP nas telas.

**Configuração por empresa:**
- Não existe tabela genérica. Seguir o padrão de `dashboard_settings`: nova `wms_settings(tenant_id PK, print_mode, label_format, label_w_mm, label_h_mm)` com RLS.
- Expor `printMode` no `WmsPrinterStatusDto` (`packages/shared/src/wms.ts:222`), que a Operação já busca.
- A UI fica em Processamento, no lugar de `<AgentSetup/>`, e mostra o instalador só no modo Zebra.

**Liberação para mentorados:**
- O Full é a feature `'full'` do tenant e vem desligado por padrão (`shared/schemas.ts:92`).
- Para liberar, criar o plano "Mentorado ML" em Master → Billing com `full` marcado; ele propaga para os assinantes.

⚠️ **Falha de segurança:** a API `/wms/*` **não confere a feature `full`**, só autenticação e modo. Uma empresa sem o recurso consegue chamar o Full direto. Adicionar um `preHandler` de feature em `wmsRoutes` antes de abrir o Full para mais empresas.

## 7. Plano de implementação

| # | Entrega | Principais arquivos |
|---|---|---|
| 0 | Guarda da feature `full` na API | `wms/presentation/routes.ts` |
| 1 | `label-pdf.ts` (3 formatos) + teste + rotas `labels.pdf`, `printed`, `printer/test.pdf` | `wms/domain`, `wms-service.ts`, `routes.ts` |
| 2 | `wms_settings` + modo navegador: sem auto-print, `ready=true`, `confirmPrinter` sem agente, `markPrinted` | migration 0044, `wms-service.ts`, `shared/wms.ts` |
| 3 | Front: `print-pdf.ts` (iframe + `print()`), `PrintZone` com "Saiu certo?", `PrinterGate`/`OperatorHome` condicionais, seletor em Processamento, botão "imprimir a lista toda" | `apps/web/src/modules/full/*` |
| 4 | Endurecer o parser: fixtures reais, conferência do total no ML, SKU vazio, quebra de página, PDF duplicado | `ml-inbound-pdf.ts`, `wms-service.ts` |
| 5 | Master Data pelos anúncios (`inventory_id` + GTIN → `listing_variants` → seed) | `ml-api.ts`, `ml-order.ts`, `sales-ingestion.ts`, migration |
| 6 | Textos e tours do mentorado; plano "Mentorado ML" | `tours.ts`, Billing |
| 7 | (Opcional) recebido × enviado via `INBOUND_RECEPTION`; envio sugerido pelo `/replenishment`; inbound manual sem PDF | `mercado-livre`, `wms` |

Os itens 0 a 3 já entregam o Full ponta a ponta para o mentorado só com ML. Os itens 4 e 5 dão robustez.

## 8. Decisões em aberto

1. Formato padrão da etiqueta: 50×25 em 1 coluna é o sugerido. Confirmar o tamanho oficial do Full na ajuda do ML, com login.
2. Formatos no lançamento: só `termica_1col`, ou os 3.
3. O modo `navegador` vira padrão para tenants novos? E o `full` entra no plano dos mentorados?
4. Fornecer 2 ou 3 PDFs reais de envio Full (podem ser anonimizados) para os testes do parser.
