import type { TourStep } from './Tour';

/**
 * Roteiros da Gertrudez por tela. O primeiro e o último passo (sem alvo) aparecem em tela cheia, como na
 * trilha de conectar o ML; os do meio viram um balão apontando o elemento. `\n` separa parágrafos na fala.
 */
export const TOURS = {
  anuncios: [
    {
      title: 'Oi! Bem-vindo aos seus Anúncios 👋',
      text:
        'Aqui ficam todos os seus anúncios do Mercado Livre, cada um num cartão com preço, margem, estoque e vendas.\n' +
        'Serve para cuidar da loja sem abrir o ML: ajustar preço e estoque, pausar, editar fotos e descrição e ver quanto sobra de cada venda.\n' +
        'Vou te mostrar cada parte em menos de 1 minuto. Tudo que você mudar aqui vai direto para o Mercado Livre.',
    },
    { target: '.lnav', title: 'Anúncios e promoções', text: '“Meus anúncios” é esta tela. Em “Central de Promoção” você coloca anúncios nas campanhas do ML vendo a margem antes de confirmar.' },
    { target: '.listings .skus-toolbar', title: 'Encontre rápido', text: 'Troque entre Ativos, Pausados e Finalizados (o número mostra quantos tem) e busque por título, SKU ou código MLB.' },
    { target: '.lgrid .lcard:first-child .lcard-media', title: 'O cartão do anúncio', text: 'Os selos mostram a situação (Ativo, Pausado), se é Full, Flex ou de catálogo.' },
    { target: '.lgrid .lcard:first-child .lcard-price', title: 'Preço e margem (MC)', text: 'MC é o que sobra por venda depois de tarifa, frete, custo e imposto. Verde é saudável (15%+), amarelo pede atenção, vermelho é risco. Preço riscado = anúncio em promoção.' },
    { target: '.lgrid .lcard:first-child .lcard-cost', title: 'Custo do produto', text: 'Sem custo não dá para saber a margem. Clique no chip para cadastrar — vale para todas as vendas desse SKU. Quando o ML banca parte de uma promoção, aparece o “bônus ML” aqui.' },
    { target: '.lgrid .lcard:first-child .lcard-stats', title: 'Os números do anúncio', text: 'Estoque: clique e digite para mudar no ML (no Full quem controla é o ML). Vendidos: a lupa abre a aba Vendas só deste anúncio. Frete, logística, fotos e medidas completam o quadro.' },
    { target: '.lgrid .lcard:first-child .lcard-edit', title: 'Editar o anúncio', text: 'Descrição, fotos (subir, reordenar, tirar), ficha técnica, dimensões, atacado B2B e Flex. Cada botão abre a parte certa com uma explicação do que ela faz.' },
    { target: '.lgrid .lcard:first-child .lcard-actions', title: 'Ações', text: '“Precificador” simula outro preço e compara Clássico × Premium. Pausar/Reativar é na hora. Em “Mais”: abrir no ML, duplicar (mesma ou outra categoria), finalizar e excluir.' },
    {
      title: 'Pronto, você já sabe tudo! 🎉',
      text:
        'Comece pelos anúncios sem custo cadastrado e pelos de margem vermelha — é ali que o dinheiro está escapando.\n' +
        'Se esquecer de algo, clique em “Rever com a Gertrudez” no topo da tela que eu explico de novo.',
    },
  ],
  promocoes: [
    {
      title: 'Central de Promoção',
      text:
        'Aqui você coloca seus anúncios nas campanhas do Mercado Livre — Black Friday, ofertas do dia, campanhas co-financiadas.\n' +
        'Serve para vender mais sem dar desconto no escuro: antes de confirmar você vê quanto vai sobrar de margem.\n' +
        'Como usar: escolha a campanha, veja quem está de fora, defina o preço e inscreva.',
    },
    { target: '.promo-list', title: '1. Escolha a campanha', text: 'As promoções abertas na sua conta, em andamento ou agendadas, com as datas. Algumas pedem que você defina o preço; outras é só aceitar as condições do ML.' },
    { target: '.promo-main .skus-toolbar', title: '2. Quem está de fora', text: 'Só aparecem anúncios que podem entrar e ainda não estão na campanha. Busque ou ordene por maior margem, maior desconto ou A–Z.' },
    { target: '.promo-grid .pcard:first-child .pcard-offer', title: '3. Preço da oferta', text: 'Ajuste dentro do mínimo e do máximo do ML ou use o sugerido. Desconto e margem atualizam na hora. Quando o ML banca parte do desconto, aparece logo abaixo.' },
    { target: '.promo-grid .pcard:first-child .lcard-actions', title: '4. Inscrever', text: 'Clique em inscrever e confirme. O anúncio entra na campanha no ML e sai desta lista.' },
    { title: 'É isso! 🎉', text: 'Dica: comece pelos anúncios com mais margem — eles aguentam o desconto e ganham exposição na campanha.' },
  ],
  vendas: [
    {
      title: 'Vendas',
      text:
        'Um painel de tudo que você vendeu: da loja inteira ou de um anúncio só.\n' +
        'Serve para entender de onde vem o dinheiro — como pagam, para onde vai, quanto sobra e quanto de DIFAL você paga.\n' +
        'Tudo vem do banco do sistema, então abre rápido mesmo com muitas vendas.',
    },
    { target: '.sales .skus-head .seg', title: 'Período', text: 'Tudo na tela segue o período escolhido: números, gráficos, DIFAL e a lista.' },
    { target: '.sales .sfilter, .sales .sfilter-chosen', title: 'Um anúncio específico', text: 'Busque um anúncio para ver só ele (com estoque de hoje e total vendido no ML). A lupa dos cards em Anúncios também te traz direto para cá.' },
    { target: '.skpis', title: 'Resumo', text: 'Vendas, unidades, receita e lucro. Se faltar custo de algum SKU, o lucro avisa em vez de mostrar um número errado.' },
    { target: '.scharts', title: 'Como e para onde vende', text: 'Formas de pagamento, modalidade de envio e os estados que mais compram. Passe o mouse para destacar cada fatia.' },
    { target: '.difal', title: 'DIFAL', text: 'O valor oficial vem da sua fatura do ML (Faturamento → Impostos). Ao lado, a estimativa pelas vendas mostra de onde ele vem: “Ver por estado” abre o detalhe e “Configurar” ajusta origem e alíquotas.' },
    { target: '.sorders > li:first-child', title: 'Venda a venda', text: 'Comprador, pedido, carrinho, CEP, pagamento e a conta completa de cada venda. Busque por cliente, pedido, CEP ou SKU e filtre pela forma de pagamento.' },
    { title: 'Pronto! 🎉', text: 'Dica: olhe os estados que mais compram e o lucro por mês — é onde aparecem as melhores decisões de preço e de estoque.' },
  ],
  precificador: [
    {
      title: 'Precificador',
      text:
        'Aqui você descobre o preço certo antes de mexer no anúncio.\n' +
        'Serve para não vender no prejuízo: mostra a margem no Clássico e no Premium e quanto cobrar para ganhar o que você quer.\n' +
        'Dá para usar com um anúncio que já existe ou simular um produto novo.',
    },
    { target: '.pcalc > .seg', title: 'De um anúncio ou livre', text: '“De um anúncio” puxa preço, custo, frete e tarifa reais do ML. “Simulação livre” é para produto novo: escolha a categoria (a % de cada uma já aparece) e as medidas — o frete sai pelo cálculo do ML.' },
    { target: '.pinputs', title: 'Os números', text: 'Mude preço, custo e imposto e a margem recalcula na hora. O frete vem do ML e fica travado; na simulação livre dá para digitar.' },
    { target: '.ptarget', title: 'Margem desejada', text: 'Diga quanto quer ganhar (ex.: 15%) e clique em “Calcular preço”: eu acho o preço e confiro a tarifa real.' },
    { target: '.pcols', title: 'Clássico × Premium', text: 'A conta completa de cada tipo. Premium cobra mais tarifa, mas dá parcela sem juros e mais exposição. Daqui você troca o tipo do anúncio, salva a simulação ou aplica o preço.' },
    { target: '.pricing .skus-head .seg', title: 'Simulações salvas', text: 'Tudo que você salvar fica aqui, por empresa, para comparar depois e ver se o preço já foi aplicado.' },
    { title: 'Agora é com você! 🎉', text: 'Dica: simule com a margem que você quer e compare os dois tipos antes de aplicar.' },
  ],
  dashboard: [
    {
      title: 'Este é o seu Dashboard 👋',
      text:
        'É o resumo do dia a dia da loja: quanto vendeu, quanto lucrou e como está a margem, comparando com o período anterior.\n' +
        'Serve para bater o olho e saber se o dia (ou o mês) está indo bem — e onde agir.\n' +
        'Os números se atualizam sozinhos com as vendas do Mercado Livre.',
    },
    { target: '.filters', title: 'Período e conta', text: 'Escolha hoje, ontem, 7 ou 30 dias, este mês ou o passado. Se tiver mais de uma conta, filtre por ela. O botão de atualizar busca os números mais recentes.' },
    { target: '.kpis', title: 'Os números principais', text: 'Faturamento, lucro, margem e pedidos. A setinha compara com o período anterior: verde subiu, vermelho caiu.' },
    { target: '.minis', title: 'Outros indicadores', text: 'Ticket médio e outros números de apoio. Se aparecer aviso de custo faltando, o lucro está incompleto — cadastre em “Cadastro de SKUs”.' },
    { target: '.chart-panel', title: 'Evolução das vendas', text: 'O gráfico mostra a receita ao longo do período (por hora quando é um dia só). Passe o mouse para ver cada ponto.' },
    { target: '.dash-duo', title: 'Mais vendidos e pausados', text: 'À esquerda os 5 produtos que mais venderam. À direita os anúncios pausados — principalmente os sem estoque, que estão deixando de vender.' },
    { title: 'Tudo certo! 🎉', text: 'Dica: compare sempre com o período anterior. Para entender de onde vem cada número, use a Análise Financeira e a aba Vendas.' },
  ],
  dre: [
    {
      title: 'Resultado do mês (DRE) 📊',
      text:
        'Aqui você vê, em linguagem simples, se a loja deu lucro ou prejuízo no mês.\n' +
        'Serve para enxergar o lucro de verdade: o que vem do Mercado Livre entra sozinho, e você só cadastra os custos da empresa (equipe, aluguel, internet…).\n' +
        'Vou te mostrar em menos de 1 minuto.',
    },
    { target: '.month-nav', title: 'Escolha o mês', text: 'Use as setinhas para ver os meses anteriores. O mês atual mostra o resultado até hoje.' },
    { target: '.dre-hero', title: 'A resposta principal', text: 'Quanto sobrou (ou faltou) no mês e quanto fica com você de cada R$ 100 vendidos. Embaixo, a comparação com o mês anterior e a previsão de fechamento.' },
    { target: '.receipt', title: 'Para onde foi o dinheiro', text: 'Como um cupom: começa no que você vendeu, desconta impostos, mercadoria, custos de venda e da empresa, e termina no que sobrou. Toque numa linha para ver os detalhes.' },
    { target: '.insight', title: 'O que fazer agora', text: 'A dica mais importante do momento: por exemplo, quanto falta vender para não ter prejuízo.' },
    { target: '.dre-costs-btn', title: 'Meus custos', text: 'O passo a passo para cadastrar equipe, aluguel, internet e outros gastos. Cadastre uma vez: eles entram sozinhos todo mês. Para funcionários, eu calculo o custo real (não é só o salário!).' },
    { target: '.view-switch', title: 'Resumo ou DRE completo', text: 'Quer ir mais fundo? O “DRE completo” mostra a cascata, os nomes que o contador usa, o ponto de equilíbrio e um simulador.' },
    { title: 'Pronto! 🎉', text: 'Comece por “Meus custos”: sem os gastos da empresa, o lucro parece maior do que é.' },
  ],
  financeiro: [
    {
      title: 'Análise Financeira',
      text:
        'Aqui está a conta completa das suas vendas: quanto entrou, quanto foi de tarifa, frete, imposto e custo, e quanto sobrou.\n' +
        'Serve para saber a margem de verdade e achar o que está comendo o seu lucro.\n' +
        'Você pode filtrar por período, conta e olhar venda por venda.',
    },
    { target: '.mkt-tabs', title: 'Marketplace', text: 'Escolha de qual marketplace quer ver a análise.' },
    { target: '.fin-filters', title: 'Período e conta', text: 'Use os atalhos (7, 30 dias…) ou escolha as datas. Se tiver mais de uma conta, filtre por ela.' },
    { target: '.fin-hero', title: 'Vendas aprovadas', text: 'O total vendido no período, com cancelamentos, devoluções parciais e o faturamento logo abaixo.' },
    { target: '.fin-mc', title: 'Margem de contribuição', text: 'O que sobra depois de todos os custos da venda. A cor mostra a faixa (saudável, atenção, risco) e o gráfico a evolução.' },
    { target: '.donut', title: 'Para onde vai o dinheiro', text: 'Quanto de cada venda vai para custo, imposto, tarifa, frete e quanto fica de margem. Passe o mouse em cada fatia.' },
    { target: '.logistics', title: 'Por modalidade de frete', text: 'Vendas por tipo de envio (Full, Flex, Coleta…). Ajuda a ver qual logística dá mais resultado.' },
    { target: '.ftable', title: 'Venda a venda', text: 'Cada venda com a conta completa. Filtre, ordene e copie o número do pedido para conferir no ML.' },
    { title: 'Pronto! 🎉', text: 'Dica: se a margem estiver baixa, veja na composição se o vilão é tarifa, frete ou custo — e ajuste no Precificador.' },
  ],
  skus: [
    {
      title: 'Cadastro de SKUs',
      text:
        'Aqui você informa quanto cada produto custa para você.\n' +
        'Serve para o sistema calcular lucro e margem de verdade — sem custo, o lucro fica incompleto em todas as telas.\n' +
        'Dá para preencher um a um aqui ou importar uma planilha de uma vez.',
    },
    { target: '.skus-actions', title: 'Planilha', text: 'Exporte a lista para preencher no Excel e importe de volta. Antes de gravar, eu mostro uma prévia do que vai mudar.' },
    { target: '.fill', title: 'Quanto falta', text: 'A barra mostra quantos SKUs já têm custo. Comece pelos mais vendidos: eles pesam mais no lucro.' },
    { target: '.taxrate', title: 'Imposto da empresa', text: 'A alíquota única de imposto vale para todas as vendas. Mudou de regime ou alíquota? Atualize aqui.' },
    { target: '.skus .skus-toolbar', title: 'Busca e filtros', text: 'Busque por SKU ou título e filtre por “Sem custo”, “Com custo” ou todos.' },
    { target: '.sku-list .sku-row:first-child .sku-cost', title: 'Digite o custo', text: 'Escreva o custo unitário e saia do campo (ou Enter): salva sozinho. O primeiro custo vale para todo o histórico; mudanças depois valem a partir do dia em que forem feitas.' },
    { title: 'É isso! 🎉', text: 'Assim que você preenche, o Dashboard, a Análise Financeira e os Anúncios já mostram o lucro certo.' },
  ],
  radar: [
    {
      title: 'Radar de Frete',
      text:
        'Todo dia eu leio quanto o Mercado Livre está cobrando de frete em cada anúncio com frete grátis.\n' +
        'Serve para pegar aquele caso que ninguém percebe: o frete que era R$ 10 e do nada vai para R$ 40, comendo a margem de todas as vendas.\n' +
        'Aqui também ficam as oportunidades de Flex: anúncios que mais vendem perto de você e ainda não têm Flex.',
    },
    { target: '.freight .skus-head .seg', title: 'Duas visões', text: '“Altas de frete” mostra o que subiu. “Oportunidades de Flex” mostra onde ativar o Flex faz mais diferença.' },
    { target: '.radar-kpis', title: 'O resumo', text: 'Quantas altas, quanto isso custa a mais por mês no seu volume de vendas, quantos anúncios estão sendo vigiados e a data da última leitura.' },
    { target: '.radar-list .radar-card:first-child', title: 'Cada alerta', text: 'Frete antes e agora (com o gráfico dos últimos 30 dias), a margem por venda antes e depois e o impacto no mês. Os botões levam direto para conferir medidas, ajustar o preço ou ativar o Flex.' },
    { title: 'Dica de ouro 🎉', text: 'Quando o frete dispara do nada, a causa mais comum é medida ou peso errado no anúncio. Comece conferindo as medidas.' },
  ],
  equipe: [
    {
      title: 'Sua equipe',
      text:
        'Aqui o MASTER cadastra quem usa o sistema.\n' +
        'Cada pessoa entra tocando no próprio nome e digitando um PIN de 4 números — na Análise, na Operação ou nas duas.',
    },
    { target: '.op-add', title: 'Cadastrar', text: 'Nome, função (Análise, Operação ou as duas) e se é MASTER. Todo mundo começa com o PIN 1234 e troca se quiser.' },
    { target: '.op-list', title: 'A equipe', text: 'Mude a função, torne MASTER, resete o PIN de quem esqueceu (ou errou 5 vezes) e desative quem saiu. Sempre fica pelo menos um MASTER.' },
    { title: 'Na Operação também 🎉', text: 'MASTER que entra na Operação tem o botão “Equipe” lá em cima para cadastrar sem precisar vir na Análise.' },
  ],
  full: [
    {
      title: 'Supervisão Full',
      text:
        'Aqui fica a expedição do Full do Mercado Livre, do PDF do envio até a etiqueta na caixa.\n' +
        'A Análise carrega o envio; a Operação separa bipando e imprime as etiquetas em PDF, em qualquer impressora.',
    },
    { target: '.full-tabs', title: 'As abas', text: 'Visão Geral (andamento e faltas), Listas e Lotes (cada envio e suas listas), Processamento (carregar o PDF) e Produtos (os códigos de barras de cada SKU).' },
    { title: 'Processamento', text: 'Baixe no ML o PDF “Lista de produtos e instruções de preparação” do envio e envie em Processamento: o sistema monta as listas de até 1.000 unidades e cadastra o Código ML e o EAN de cada produto.' },
    { title: 'Na Operação 🎉', text: 'Quem entra na Operação pega uma lista (ou bipa um produto no atalho) e separa. Ao terminar cada item, as etiquetas com o Código ML vão para a impressora.' },
  ],
  'central-devolucoes': [
    {
      title: 'Central de Devoluções ↩︎',
      text:
        'Aqui chega tudo que o comprador devolveu no Mercado Livre: o que está a caminho, o que chegou para conferir e o que vale contestar.\n' +
        'O sistema busca no ML sozinho a cada 10 minutos e mostra quanto cada devolução custou — frete reverso e produto quebrado.\n' +
        'Vou te mostrar as partes em menos de 1 minuto.',
    },
    { target: '.cd-abas', title: 'As abas', text: 'Resumo (o panorama), Operação (a bancada do bipe), B.I (custos, motivos, Full × orgânica e a fatura do ML), Histórico, Quebrados, Estoque virtual, Retorno Full e Operadores (quem conferiu o quê).' },
    { target: '.cd-busca', title: 'Bipe de qualquer lugar', text: 'Bipe a etiqueta, o QR code ou a nota do pacote — ou digite o pedido ou rastreio. A conferência abre por cima da tela em que você está (atalho Ctrl K).' },
    { target: '.central-dev .kpis', title: 'O panorama', text: 'Quantas devoluções estão abertas, quantas precisam de ação, quantas vêm a caminho e quantas estão em mediação. Clique em qualquer número para abrir a lista já filtrada.' },
    { target: '.central-dev .financeiro', title: 'Quanto custou', text: 'Frete reverso já cobrado, frete em mediação (cobra se perder) e o que voltou quebrado — conferido na bancada ou declarado no motivo da devolução.' },
    { target: '.central-dev .atencao', title: 'O que fazer primeiro', text: 'Pacotes que chegaram e esperam conferência, devoluções para contestar, estoque para lançar, chamados manuais e prazos que vencem em 24 h.' },
    { target: '.cd-head-acoes', title: 'Sincronização', text: 'O selo mostra a última leitura do Mercado Livre. Se precisar de ajuda de novo, é só clicar em “Rever com a Gertrudez”.' },
    {
      title: 'Pronto! 🎉',
      text:
        'Sem ERP ligado, o produto bom volta direto para o estoque do anúncio no Mercado Livre; o quebrado e o divergente vão para o Estoque virtual.\n' +
        'Comece pelo “O que precisa da sua atenção” — é ali que o prazo do ML corre.',
    },
  ],
  'central-devolucoes-op': [
    {
      title: 'Bancada de devoluções 📦',
      text:
        'Aqui você confere o que o comprador devolveu: bipa o pacote, responde umas perguntas sobre o produto, tira as fotos e o sistema diz o que fazer.\n' +
        'Vou te mostrar como funciona.',
    },
    { target: '.central-dev .bipe-cartao', title: '1. Bipe o pacote', text: 'Bipe a etiqueta, o QR code ou a nota que veio no pacote. Se o leitor não achar, digite o número do pedido — a etiqueta fica vinculada para o próximo bipe.' },
    { target: '.central-dev .abas-operador', title: '2. O que tem para fazer', text: 'Chegaram (conferir agora), Falta terminar (lançar estoque, contestar ou chamado), A caminho, Em mediação e Concluídas. Clique para ver a lista.' },
    { target: '.cd-abas', title: 'Outras abas', text: 'Histórico mostra as já resolvidas. Retorno Full é onde entra o que voltou do CD do Full: bipe a etiqueta do Full (4 letras + 5 números) e diga a quantidade.' },
    {
      title: 'A conferência em 4 passos ✅',
      text:
        'Conferir: é o produto certo? está completo? sem uso? dá para vender de novo?\n' +
        'Fotos e vídeo: produto e embalagem, para a contestação. Estoque: o bom volta para o anúncio no Mercado Livre; o quebrado vai para o estoque virtual.\n' +
        'Por último, aceitar ou contestar no ML. Qualquer dúvida, clique em “Rever com a Gertrudez”.',
    },
  ],
  'operacao-inicio': [
    {
      title: 'Oi! Eu sou a Gertrudez 👋',
      text:
        'Este é o computador da operação. Aqui você escolhe o que vai fazer agora e eu te ajudo em cada tela.\n' +
        'Vamos ver as opções?',
    },
    { target: '.op-choice-full', title: 'Supervisão Full', text: 'Para montar o envio do Full: pegue uma lista, bipe cada produto e imprima as etiquetas com o Código ML.' },
    { target: '.op-choice-dev', title: 'Devoluções', text: 'Para o que voltou do comprador: bipe o pacote, confira o produto, tire as fotos e lance no estoque.' },
    { target: '.op-switch', title: 'Trocar de tarefa', text: 'Pelo topo você troca entre Início, Supervisão Full e Devoluções a qualquer momento, sem sair da sua conta.' },
    {
      title: 'Bom trabalho! 🎉',
      text: 'Cada tela tem a sua explicação na primeira vez. Se esquecer de algo, clique em “Rever com a Gertrudez”.',
    },
  ],
  'full-operacao': [
    {
      title: 'Separar o Full 📦',
      text:
        'Aqui você monta o envio para o Full: pega uma lista, bipa cada produto e imprime as etiquetas com o Código ML.\n' +
        'Vou te mostrar onde fica cada coisa.',
    },
    { target: '.full-op-search', title: 'Atalho: bipe qualquer produto', text: 'Bipe o código de barras (ou digite SKU ou nome) e o sistema abre a lista certa já no produto. Se ele estiver com outra pessoa, oferece transferir para você.' },
    { target: '.full-op-sec', title: 'Suas listas e a fila', text: 'Primeiro as listas que já estão com você; depois as livres. Clique numa lista para começar a separar.' },
    { target: '.full-tabs', title: 'As abas', text: 'Visão Geral (o andamento do envio), Listas e Lotes, Faltas (o que não foi achado — marque como resolvida quando repor) e Produtos (os códigos de cada SKU).' },
    {
      title: 'Na tela de separar ✅',
      text:
        '1. Escolha: caixa fechada (bipa uma vez e diz quantas) ou peça por peça. 2. Bipe o código de barras.\n' +
        'Achou menos? Use “Achei menos”. Não tem nenhum? “Sem estoque”. Tudo vai para o Relatório de Faltas. Qualquer dúvida, clique em “Rever com a Gertrudez”.',
    },
  ],
} satisfies Record<string, TourStep[]>;
