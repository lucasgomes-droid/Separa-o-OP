# Separação de OP — ICC Brazil

App para abrir, acompanhar e controlar a separação de Ordens de Produção, no mesmo modelo da Central de Frota: site estático (GitHub Pages) + Google Apps Script + Google Planilhas como base de dados.

## 1. Arquitetura

```
 Celular / computador                 Google                         Google Planilhas
 ┌──────────────────────┐   fetch()   ┌────────────────────────┐     ┌─────────────────────┐
 │ index.html · app.js  │ ──────────► │ Apps Script (Code.gs)  │ ──► │ SEPARACOES          │
 │ style.css (PWA)      │ ◄────────── │ Web App /exec          │ ◄── │ IMPACTOS            │
 │ fila offline (local) │    JSON     │ regras · trava · login │     │ CONFIG_USUARIOS     │
 └──────────────────────┘             └────────────────────────┘     │ LOG_EVENTOS · _SEQ  │
                                                                     └─────────────────────┘
```

- **Frontend** (`index.html`, `app.js`, `style.css`, `manifest.json`, `sw.js`): JavaScript puro, sem build. Instalável como app no celular. Responsivo: barra inferior no celular, barra lateral no computador.
- **Backend** (`Code.gs`): API única. Todas as regras de negócio ficam no servidor (o app só ajuda), então nenhum aparelho consegue furar o bloqueio de OP duplicada ou de segunda OP por conferente.
- **Base**: a planilha. Leituras por GET; gravações por POST (texto JSON, sem preflight CORS).

### Como a integração com a planilha evita perda e duplicidade

| Risco | Proteção |
|---|---|
| Duas gravações ao mesmo tempo | Trava do script (`LockService`): só um pedido grava por vez; o ID é gerado dentro da trava. |
| Clique duplo, reenvio, timeout | Cada abertura/finalização leva um `idRequisicao` gravado na própria linha (`ID_REQ_INICIO` / `ID_REQ_FIM`). Pedido repetido devolve o registro já gravado. |
| Internet caiu | O registro entra numa **fila no aparelho antes do envio** e só sai quando a planilha confirma. Reenvio automático a cada 20 s, ao voltar a conexão e ao reabrir o app. Faixa laranja mostra quantos estão pendentes. |
| Hora errada por envio atrasado | O app grava a hora do **toque no botão**, corrigida pelo relógio do servidor. O servidor aceita essa hora se não estiver no futuro nem mais de 12 h no passado. |
| OP aberta duas vezes | Bloqueio de mesma OP + tipo em andamento. OP já separada antes só reabre com confirmação (fica anotado em OBSERVACAO). |
| Abertura por engano | Gestor cancela com motivo; a linha fica na planilha como `cancelada` e sai das médias. Finalizar com menos de 1 minuto é recusado. |
| Planilha editada à mão durante a gravação | A atualização confere o ID da linha antes de gravar. |
| Sessão | Token assinado (HMAC), válido por 7 dias. Trocar a senha ou o tipo do usuário na planilha derruba as sessões antigas dele. 5 senhas erradas = bloqueio de 15 min. |

## 2. Estrutura da base de dados

**SEPARACOES** — uma linha por separação
| Coluna | Conteúdo |
|---|---|
| ID_SEPARACAO | `SEP-000001` |
| NUMERO_OP | número da OP (texto; mantém zero à esquerda) |
| TIPO_OP | Fábrica · Ribbon · Líquido |
| QTD_KG | quantidade total em kg (número) |
| OPERADORES / AJUDANTES | quantidade de pessoas (número) |
| ID_CONFERENTE / CONFERENTE | quem abriu (vem do login) |
| STATUS | `andamento` · `finalizada` · `cancelada` |
| INICIO / FIM | data e hora ISO com fuso (ex.: `2026-10-18T14:32:00-03:00`) |
| DIA | `yyyy-MM-dd` do início — para tabela dinâmica |
| DURACAO_MIN | duração em minutos (número) |
| TEVE_IMPACTO | `SIM` / `NAO` |
| MOTIVOS_IMPACTO | motivos separados por `|` |
| FINALIZADO_POR | quem finalizou ou cancelou |
| OBSERVACAO | reabertura confirmada / motivo do cancelamento |
| REGISTRADO_EM / ATUALIZADO_EM | hora em que o servidor gravou |
| ID_REQ_INICIO / ID_REQ_FIM | identificadores anti-duplicidade |

**IMPACTOS** — uma linha por motivo informado: `ID_IMPACTO, ID_SEPARACAO, NUMERO_OP, TIPO_OP, CONFERENTE, MOTIVO, DESCRICAO, DATA_HORA`. O vínculo com a OP é o `ID_SEPARACAO`.

**CONFIG_USUARIOS**: `ID_USUARIO, NOME, TIPO (CONFERENTE | GESTOR), SENHA, ATIVO (SIM | NAO)`. Gestor sempre entra com senha; conferente entra escolhendo o nome, a menos que tenha SENHA preenchida.

**LOG_EVENTOS**: trilha de auditoria (INICIO, FIM, CANCELAMENTO, quem e quando). **_SEQ**: contadores dos IDs.

## 3. Fórmulas dos indicadores

Todas usam só OPs **finalizadas**; o período considera a **data de início** da separação.

- Tempo médio por OP = Σ duração ÷ nº de OPs
- Produtividade (kg/h) = Σ kg ÷ Σ horas de separação
- kg/h por operador = Σ kg das OPs com operador ÷ Σ (operadores × horas da OP)
- kg/h por ajudante = Σ kg das OPs com ajudante ÷ Σ (ajudantes × horas da OP)
- kg/h por pessoa = Σ kg ÷ Σ ((operadores + ajudantes) × horas da OP)

São médias ponderadas pelo tempo (não "média de médias"): uma OP de 10 minutos não pesa o mesmo que uma de 4 horas. O mesmo cálculo é usado por tipo, por conferente, por motivo de impacto e na evolução por dia/semana/mês. A tela do dashboard tem o quadro "Como cada indicador é calculado".

## 4. Configuração passo a passo

1. **Planilha**: crie uma planilha nova no Google Drive (ex.: "Separação de OP — Base").
2. **Apps Script**: na planilha, *Extensões > Apps Script*. Apague o conteúdo e cole o `Code.gs`.
3. **Fuso horário**: *Configurações do projeto (engrenagem)* > marque "Mostrar arquivo appsscript.json" e substitua pelo `appsscript.json` deste pacote (ou só escolha o fuso **(GMT-03:00) São Paulo**).
4. **Criar as abas**: escolha a função `configurarPlanilha` e clique ▶ **Executar**. Autorize o acesso quando o Google pedir. As abas aparecem com os cabeçalhos e 3 usuários de exemplo.
5. **Usuários**: na aba `CONFIG_USUARIOS`, troque a senha do gestor (`1234`) e cadastre os conferentes reais (ID único, ex.: `USR-010`, TIPO `CONFERENTE`, ATIVO `SIM`).
6. **Publicar**: *Implantar > Nova implantação > App da Web* — Executar como: **Eu**; Quem pode acessar: **Qualquer pessoa**. Copie a URL que termina em `/exec`.
7. **Frontend**: em `app.js`, troque `COLE_A_URL_DO_APPS_SCRIPT_AQUI` pela URL `/exec`.
8. **Ícones**: copie do repositório da Central de Frota os arquivos `logo.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` e `icon-maskable-512.png` (mesmos nomes).
9. **Hospedar**: crie um repositório no GitHub (ex.: `separacao-op`), envie `index.html`, `app.js`, `style.css`, `manifest.json`, `sw.js` e os ícones, e ative *Settings > Pages* (branch `main`, pasta `/`). O app fica em `https://<usuario>.github.io/separacao-op/`.
10. **Instalar no celular**: abra o endereço no Chrome e use "Adicionar à tela inicial".

**Sempre que alterar o `Code.gs`**: *Implantar > Gerenciar implantações > lápis > Versão: Nova versão > Implantar*. Sem isso a URL continua com o código antigo.

## 5. Roteiro de testes

Use dois aparelhos (ou duas janelas anônimas) para os testes de tempo real.

| # | Funcionalidade | Como testar | Resultado esperado |
|---|---|---|---|
| 1 | Login | Conferente → nome; Gestor → nome + senha errada, depois certa | Conferente entra direto; senha errada é recusada |
| 2 | Iniciar separação | Conferente > Iniciar Separação; deixe campos vazios e toque Iniciar | Avisos em cada campo obrigatório |
| 3 | | Preencha tipo, OP, kg (aceita `1.250,5`), operadores, ajudantes e confirme | Cronômetro começa; linha nova em SEPARACOES com STATUS `andamento` e INICIO |
| 4 | Uma OP por conferente | Com OP aberta, volte à tela inicial | Não há botão Iniciar; mesmo forçando, o servidor recusa ("Você já tem a OP…") |
| 5 | Mesma OP duas vezes | Outro conferente tenta abrir a mesma OP e tipo | Recusado: "já está sendo separada por…" |
| 6 | Em andamento / tempo real | Abra "Em andamento" no 2º aparelho | Cartão com conferente, OP, tipo, kg, equipe, início e cronômetro; atualiza sozinho a cada 15 s; cor muda ao passar da média do tipo |
| 7 | Finalizar | Finalizar Separação > marque um motivo sem descrever | Pede descrição obrigatória |
| 8 | | Descreva e finalize | STATUS `finalizada`, FIM, DURACAO_MIN preenchidos; uma linha por motivo em IMPACTOS |
| 9 | Sem impacto | Finalize outra marcando "Não houve impacto" | TEVE_IMPACTO = `NAO` |
| 10 | Duplicidade | Toque Finalizar duas vezes rápido / repita o envio | Uma finalização só |
| 11 | Sem internet | Ative o modo avião, inicie e finalize uma OP | Faixa laranja "registro guardado"; nada se perde |
| 12 | | Desative o modo avião | A faixa some sozinha; as linhas aparecem na planilha com a hora do toque |
| 13 | Ao vivo (gestor) | Login de gestor > Ao vivo | Conferentes ocupados e livres, OP de cada um, pessoas em campo, kg em separação, finalizadas hoje |
| 14 | Cancelar | Gestor > Em andamento > cartão > Cancelar abertura | STATUS `cancelada` com motivo; conferente fica livre |
| 15 | Histórico | Filtre por dia, semana, mês, conferente, tipo, número da OP, status e impacto | Lista com início, término, tempo total, kg e equipe; Exportar CSV abre no Excel |
| 16 | Dashboard | Gestor > Dashboard; troque período, tipo e conferente | Indicadores, comparativo por tipo, motivos, efeito dos impactos, evolução por dia/semana/mês |
| 17 | Conferir as contas | Na planilha, some QTD_KG e DURACAO_MIN das finalizadas do mês | kg/h do dashboard = Σ kg ÷ (Σ minutos ÷ 60) |

## 6. Manutenção

- Corrigir dado digitado errado (kg, equipe): edite a célula direto na aba SEPARACOES; o app recalcula tudo na próxima leitura. Não altere IDs nem as colunas ID_REQ_*.
- Desativar conferente: ATIVO = `NAO` (o histórico dele continua).
- Volume: a planilha aguenta dezenas de milhares de separações. Se ficar lenta, mova as linhas de anos anteriores para outra planilha.
- O histórico na tela mostra até 1.000 registros por consulta; o CSV e a planilha têm tudo.
