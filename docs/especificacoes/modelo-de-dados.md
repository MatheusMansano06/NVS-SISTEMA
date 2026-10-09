# Modelo de dados — fundação

PostgreSQL. Migrações com Alembic em `banco/migracoes/`. Nomes em português, `snake_case`.
Escopo: o que a v1 (13 telas) precisa. O que é v2 está marcado e já tem lugar reservado.

## Regras que valem para todas as tabelas
- **Chave primária:** `uuid` (`gen_random_uuid()`); nunca id sequencial exposto na API.
- **Dinheiro:** `numeric(14,2)` em BRL. Nunca `float`.
- **Tempo:** `timestamptz` em UTC. O "dia" de negócio é `dia_local date`, calculado em
  `America/Sao_Paulo` na gravação.
- **Isolamento:** toda tabela de negócio tem `empresa_id uuid not null` e **Row Level Security**
  ativa e forçada (ver §6).
- **Dados pessoais de comprador:** **não guardamos** nome, CPF, telefone ou endereço. Só o que o
  lucro precisa. Menos dado = menos risco e menos obrigação de LGPD.
- Toda tabela tem `criado_em` e `atualizado_em`.

## 1. Identidade e empresas
| Tabela | Colunas principais | Observações |
|---|---|---|
| `usuarios` | id, email (único, case-insensitive), senha_hash (argon2), dois_fatores bool | Um usuário pode estar em várias empresas |
| `empresas` | id, nome, cnpj | |
| `membros` | usuario_id, empresa_id, papel (`dono`, `admin`, `operador`, `leitura`) | PK (usuario_id, empresa_id). Base dos sub-usuários e, na v3, das agências |
| `configuracoes_empresa` | empresa_id (PK), margem_excelente (19), margem_boa (11), so_vendas_full bool | Faixas de margem editáveis |

## 2. Contas de marketplace e credenciais
| Tabela | Colunas principais | Observações |
|---|---|---|
| `contas_marketplace` | id, empresa_id, marketplace (`ml`, `shopee`), id_externo, apelido, imposto_percentual numeric(5,2), status (`ativa`, `reautorizar`, `desligada`) | **Único (marketplace, id_externo)**: a mesma conta de ML não pode estar em duas empresas |
| `credenciais_conta` | conta_id (PK), access_token_cifrado, refresh_token_cifrado, expira_em, escopos, versao_chave | Tabela separada, acesso mínimo. Cifra AES-GCM na aplicação; a chave só existe no Railway. `versao_chave` permite girar a chave |
| `oauth_estados` | state_hash, empresa_id, usuario_id, marketplace, expira_em, usado_em | `state` aleatório, guardado como hash, **uso único**, expira em 10 min |
| `escrita_modulos` | conta_id, modulo, habilitada bool | Implementa "nasce só leitura": ação de escrita no marketplace só roda se a linha existir e estiver habilitada |

Renovação de token: um único processo por conta por vez, com `pg_advisory_xact_lock(hash(conta_id))`.
O token do ML é de uso único; renovação concorrente derruba a cadeia.

## 3. Catálogo e vínculo (o coração do produto)
| Tabela | Colunas principais | Observações |
|---|---|---|
| `produtos` | id, empresa_id, sku_interno, nome, ativo | Único (empresa_id, sku_interno) |
| `produto_custos` | produto_id, empresa_id, valido_desde date, custo numeric(14,2) | **Custo com histórico**: o lucro de uma venda usa o custo vigente na data dela |
| `anuncios` | id, empresa_id, conta_id, id_externo, variacao_id (nulo se não há), titulo, sku_externo, preco, status, foto_url, **produto_id (nulo = não associado)** | Único (conta_id, id_externo, variacao_id). **A associação é `produto_id`**; vários anúncios podem apontar para o mesmo produto |
| `produto_componentes` *(v2)* | produto_id, componente_id, quantidade | Kits. Reservado, não entra na v1 |

## 4. Pedidos
| Tabela | Colunas principais | Observações |
|---|---|---|
| `pedidos` | id, empresa_id, conta_id, id_externo, status (`confirmado`, `pendente`, `cancelado`, `reembolsado`), logistica, criado_em_utc, pago_em, dia_local, total, tarifa_venda, frete_vendedor, desconto_vendedor, liquido_marketplace | Único (conta_id, id_externo). `liquido_marketplace = total − tarifa_venda − frete_vendedor − desconto_vendedor`, gravado na sincronização |
| `itens_pedido` | id, pedido_id, empresa_id, anuncio_id, produto_id (nulo = sem vínculo), sku_externo, titulo, quantidade, preco_unitario, **custo_unitario_aplicado (nulo = sem custo)**, imposto_aplicado, custo_extra | Nulo em custo ou produto alimenta o aviso "sem custo" e "sem vínculo". `imposto_aplicado` guarda o percentual da conta na data |
| `pagamentos` *(v2)* | id, pedido_id, id_externo, status, valor, liberacao_prevista, liberado_em | Base da Conciliação e do fluxo de caixa |
| `devolucoes` *(v2)* | id, pedido_id, status, motivo, valor | Base de Reembolsos |

Lucro de um item = `(preco_unitario × quantidade) − tarifas rateadas − custo_unitario_aplicado × quantidade
− imposto − custo_extra`. Item sem custo tem lucro **marcado como incompleto**, nunca zero silencioso.

## 5. Agregados (o que torna as telas rápidas)
| Tabela | Chave | Conteúdo |
|---|---|---|
| `resumo_diario` | (empresa_id, conta_id, dia_local) | pedidos, unidades, faturamento, liquido, custo, imposto, lucro, itens_sem_custo |
| `resumo_produto_diario` | (empresa_id, conta_id, dia_local, produto_id) | unidades, faturamento, liquido, custo, lucro. Alimenta tabela por produto, Curva ABC e tendência 30/60/90/120 |

Recalculados **por dia afetado** quando um pedido muda ou quando um custo é cadastrado. Cadastrar
um custo dispara tarefa que preenche `custo_unitario_aplicado` dos itens sem custo e refaz os dias.
Dashboard, Vendas agregada, Analítico e DRE leem só daqui.

## 6. Finanças operacionais
| Tabela | Colunas principais |
|---|---|
| `categorias_operacionais` | id, empresa_id, nome, tipo (`despesa`, `receita`), pai_id |
| `movimentacoes_operacionais` | id, empresa_id, categoria_id, tipo, valor, competencia (mês), descricao, recorrente bool |

## 7. Sincronização e auditoria
| Tabela | Conteúdo |
|---|---|
| `sincronizacoes` | conta_id, recurso, cursor, ultima_execucao, status — retoma de onde parou |
| `notificacoes_recebidas` | conta_id, topico, recurso, recebido_em, processado_em; **único** por (conta_id, topico, recurso, hash) para o webhook ser idempotente |
| `auditoria` | empresa_id, usuario_id, acao, entidade, entidade_id, detalhes jsonb, ip, criado_em — só inserção, **nunca** com token ou senha |

## 8. Isolamento no banco (RLS)
- Em cada tabela de negócio: `ENABLE` e `FORCE ROW LEVEL SECURITY`, com política
  `empresa_id = current_setting('app.empresa_id')::uuid`.
- A API abre cada transação com `SET LOCAL app.empresa_id = …`, depois de confirmar em `membros`
  que o usuário pertence àquela empresa.
- A aplicação conecta com um papel **sem** `BYPASSRLS` e sem permissão de alterar esquema; a
  migração roda com outro papel.
- Sem `app.empresa_id` definido, a consulta devolve **zero linhas**, não todas.

## 9. Índices desde o dia 1
`pedidos (empresa_id, conta_id, dia_local)` · `itens_pedido (pedido_id)` ·
`itens_pedido (empresa_id) WHERE custo_unitario_aplicado IS NULL` (aviso "sem custo") ·
`anuncios (empresa_id) WHERE produto_id IS NULL` ("não associados") · `anuncios (empresa_id, produto_id)`.

## 10. Verificações que acompanham a fundação
1. **Isolamento:** com a empresa A ativa, `SELECT` direto em qualquer tabela nunca devolve linha da B; sem variável definida, devolve zero.
2. **Conta única:** associar a mesma conta de ML a uma segunda empresa falha.
3. **Token:** nenhum teste nem log contém token em texto; o valor no banco não é legível.
4. **Custo retroativo:** cadastrar custo preenche os itens sem custo e corrige `resumo_diario` dos dias afetados.
5. **Webhook:** o mesmo aviso entregue duas vezes processa uma vez.
6. **Escrita:** ação de escrita numa conta sem `escrita_modulos` habilitada é recusada.
