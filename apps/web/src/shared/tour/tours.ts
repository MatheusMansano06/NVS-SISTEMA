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
    { target: '.sorders', title: 'Venda a venda', text: 'Comprador, pedido, carrinho, CEP, pagamento e a conta completa de cada venda. Busque por cliente, pedido, CEP ou SKU e filtre pela forma de pagamento.' },
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
} satisfies Record<string, TourStep[]>;
