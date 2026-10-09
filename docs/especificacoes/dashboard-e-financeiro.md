# Especificação — Dashboard e Financeiro

Método sala limpa: o comportamento foi observado na tela de um concorrente; as definições,
fórmulas e dados abaixo são nossos, derivados da API do Mercado Livre. Nenhum código, texto
ou nome de campo de terceiros é reaproveitado.

Estado: **Dashboard = especificado.** Financeiro = esqueleto (telas ainda não observadas).

## 1. Dashboard

**Objetivo:** em uma tela, dizer ao vendedor quanto vendeu, quanto sobrou e quais produtos
puxaram o resultado, para o período e as contas escolhidos.

### Filtros
- **Período:** Hoje · Ontem · 7 dias · 15 dias · 30 dias · Este mês · Mês passado · Este ano · Personalizado.
- **Contas:** Todas ou uma seleção das contas de marketplace da empresa.
- **Atualizar dados do período:** força a sincronização do período e mostra "atualizado há N min".
  Limitado a uma execução por conta a cada 5 minutos.
- Dia calendário em `America/Sao_Paulo`. Mudar filtro responde em até 200 ms (p95).

### Indicadores (linha 1)
| Indicador | Definição |
|---|---|
| Faturamento | Soma do valor dos pedidos pagos no período, sem cancelados |
| Líquido do marketplace | Faturamento − tarifa de venda − frete pago pelo vendedor − descontos bancados por ele |
| Lucro | Líquido − custo dos produtos − imposto da conta (% configurado por conta) |
| Margem | Lucro ÷ Faturamento |

### Indicadores (linha 2)
Pedidos · Unidades vendidas · Ticket médio (Faturamento ÷ Pedidos) · Investimento em Ads ·
ROAS (receita atribuída a Ads ÷ gasto) · TACOS (gasto Ads ÷ Faturamento) · Lucro pós-Ads
(Lucro − Ads). Blocos de Ads só aparecem se a conta tiver Ads conectado.

Cada indicador mostra a variação contra o período anterior de mesma duração.

### Gráfico
Série diária de Faturamento e Lucro. Ao passar o mouse, mostra o dia com Faturamento,
Líquido, Lucro, Ticket médio, Pedidos e Unidades. Exporta CSV.

### Tabela "Resumo de receitas" (por produto)
Colunas: Produto · Preço médio · Custo unitário médio · Unidades · Faturado · Participação
(% do total) · Lucro · Margem · Custo Ads · Lucro pós-Ads. Ordenável por qualquer coluna.
Também há "Top 15 produtos mais vendidos".

### Regras que tornam o número confiável
- **Produto sem custo:** o Lucro dele é marcado como *incompleto* e a tela avisa quantos
  produtos estão sem custo, com atalho para cadastrar. Nunca somar como se o custo fosse zero
  sem avisar.
- **Cancelamento e devolução:** saem do Faturamento; devolução já concluída entra como
  estorno no dia em que ocorreu.
- **Pedido pago em vários pagamentos:** conta uma venda só.
- **Vazio:** período sem vendas mostra estado vazio explicativo, não zeros soltos.
- **Fonte única:** todos os números vêm de agregados diários no Postgres (por empresa, conta
  e dia); nenhuma requisição de tela chama a API do marketplace.

### Dados necessários
Pedidos e itens (ML Orders), pagamentos e tarifas (Payments), envio (Shipments), custo por
produto (cadastro NVS), imposto por conta, gasto de Ads (Product Ads).

### Critérios de aceite
1. Para uma amostra de pedidos conhecidos, Faturamento, Líquido e Lucro batem com o cálculo manual.
2. Trocar período ou conta atualiza indicadores, gráfico e tabela juntos, em até 200 ms.
3. Uma empresa nunca vê pedido de outra (teste de isolamento).
4. Produto sem custo aparece sinalizado e o aviso do topo mostra a contagem correta.
5. Exportar CSV reproduz exatamente os pontos do gráfico.

## 2. Financeiro (esqueleto — a detalhar após observação)

| Tela | Pergunta que responde | Origem provável dos dados |
|---|---|---|
| Resumo | Para onde foi o dinheiro: custo, tarifas, frete, impostos, lucro | Mesmos agregados do Dashboard |
| Fluxo de caixa | Quanto vou receber e quando | Data de liberação dos pagamentos do ML |
| Despesas | Quanto gasto fora das vendas | Cadastro manual por categoria, com recorrência |
| Liquidação | O que o marketplace já repassou | Movimentações da conta de pagamentos |
| Reembolsos | O que voltou e por quê | Reclamações e devoluções |

Cada uma será especificada depois de observar a tela correspondente.
