# NVS NOVO — plataforma multi-empresa para vendedores de marketplace

Software de nível corporativo: dados financeiros de terceiros. Prioridade, nesta ordem:
**segurança → correção → latência → clareza do código**. Em dúvida, a opção mais segura.

Convive com o NOVAES-ESTOQUE (pasta irmã), que **não deve ser alterado**. Este projeto
tem credenciais, banco e serviço próprios. A NOVAES é a empresa nº 1 deste sistema.

## Stack
Backend: Python 3.11+ · FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL.
Frontend: React 18 · TypeScript estrito · Vite. Deploy: Railway (projeto "NVS NOVO").

## Estrutura (cada coisa no seu lugar)
```
backend/app/
  nucleo/            configuração, segurança, banco, contexto da empresa
  modulos/<trilha>/  uma pasta por funcionalidade (ver abaixo)
  integracoes/<mkt>/ só conversam com a API externa (mercado_livre, shopee, olist)
  tarefas/           sincronização agendada
backend/testes/
frontend/src/
  aplicacao/         menu, rotas, layout
  compartilhado/     componentes de interface, cliente da API, hooks
  modulos/<trilha>/  telas da funcionalidade
banco/               migrações, sementes, políticas de isolamento (RLS)
infra/               Dockerfile, deploy, CI
docs/                decisões de arquitetura (curtas)
```
Trilhas: autenticacao, empresas, contas, dashboard, vendas, financeiro, anuncios, estoque…

## Trilhas isoladas
- Cada trilha é autocontida (backend e frontend). Uma trilha só usa outra pela função
  **pública** do seu `*_servico.py`; nunca importa o interior de outra.
- Um teste de importações falha o build se alguém cruzar essa linha.
- Funcionalidade nova = trilha nova. Mexer numa trilha não pode exigir mexer em outra.

## Nomes de arquivo: claros e únicos
Nada de `service.py` repetido. Padrão: `<trilha>_rotas.py`, `<trilha>_servico.py`,
`<trilha>_repositorio.py`, `<trilha>_esquemas.py`, `test_<trilha>_*.py`.
Frontend: componente em PascalCase com nome do que faz (`TabelaVendas.tsx`,
`ResumoFinanceiro.tsx`). Um arquivo, uma responsabilidade. Arquivo que cresce → divide.

## Código direto
- Se dá em 10 linhas, não escreva 35. Reuse o que existe antes de criar.
- Função curta, uma responsabilidade. Sem abstração para um único uso.
- Comentário só quando o **porquê** não é óbvio. Nunca descreva o que o código já diz.
- Type hints em tudo (backend) e TypeScript estrito (frontend). Lint e tipos limpos.

## Segurança (inegociável)
- **Isolamento entre empresas em duas camadas:** filtro por `empresa_id` na aplicação **e**
  Row Level Security no Postgres. Toda tabela de negócio tem `empresa_id`.
- Senhas com **argon2**. Tokens de marketplace **criptografados no banco**; a chave só
  existe como variável de ambiente.
- Sessão em cookie HttpOnly + Secure + SameSite. OAuth com `state` assinado e uso único.
- Toda entrada validada (Pydantic). Limite de requisições. Cabeçalhos de segurança.
- Log de auditoria de ações sensíveis. Nunca registrar token, senha ou segredo em log.
- Segredos só em variáveis de ambiente, **nunca** no repositório nem no chat.
- Rota chamada por fora (webhook/callback) é a exceção explícita e validada: o webhook do
  ML não traz assinatura, então confirma o recurso consultando a API antes de agir.
- CI barra o que for inseguro: gitleaks, bandit, semgrep, pip-audit, npm audit.
- Skill ou dependência de terceiros: ler antes de instalar. Nada entra sem revisão.

## Latência
- A aplicação lê **só do próprio banco**; nunca espera a API do marketplace numa requisição.
- Dados chegam por webhook e por tarefa agendada por conta. Token com trava na renovação
  (uso único: renovação concorrente derruba a cadeia).
- Índices desde a primeira tabela, paginação em toda listagem, sem consulta N+1.
- Meta: leituras abaixo de 200 ms no p95. Telas do front carregam sob demanda.

## Empresas e integrações opcionais
- Hierarquia: usuário → empresa → contas de marketplace (cada conta com imposto próprio).
- Estoque próprio é o padrão. Olist e Tiny são integrações opcionais por empresa; o menu
  e as telas mudam conforme o que a empresa conectou.
- ML: app próprio (credenciais separadas do NOVAES-ESTOQUE). Escrita nos marketplaces fica
  **desligada** por padrão para a NOVAES, liberada módulo a módulo.

## Referência de produto (método sala limpa)
Estudar concorrente é permitido; copiar código não. Fluxo: observar o comportamento da tela
→ escrever a **especificação** em `docs/` → implementar do zero a partir da API do
marketplace e das regras de negócio. Nunca transcrever código, textos ou assets de terceiros.

## Ordem de entrega
1. Fundação: Postgres, login, empresa, contas, OAuth do ML por conta.
2. Núcleo: Dashboard, Vendas, Curva ABC, Financeiro, Contas.
3. Anúncios e estoque próprio.
4. Diferenciais opcionais por empresa: devoluções, Radar do Full, inbound, Olist, Shopee.

## Processo
Nada de código antes do desenho aprovado. Cada trilha: especificação curta → plano → testes
→ implementação. Uma verificação rodável por lógica não trivial (dinheiro, segurança, parser).
