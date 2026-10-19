# Separação Ordem de Produção
Frontend React (GitHub Pages) + Google Sheets/Apps Script. Sem servidor extra, sem segredos no repositório.

## 1. GitHub (≈3 min)
1. Crie um repositório e envie estes arquivos (`git init && git add . && git commit -m v1 && git branch -M main && git remote add origin <URL> && git push -u origin main`).
2. Em **Settings ▸ Pages ▸ Source**, escolha **GitHub Actions**. A cada push o site é publicado em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

## 2. Google Planilhas (≈5 min)
1. No Google Drive, envie `planilha-modelo.xlsx`, abra e use **Arquivo ▸ Salvar como Planilhas Google**.
2. **Extensões ▸ Apps Script**: apague o conteúdo, cole `apps-script/Code.gs` e salve.
3. **Implantar ▸ Nova implantação ▸ App da Web** · Executar como: **Eu** · Quem tem acesso: **Qualquer pessoa** · Implantar · autorize · **copie a URL** (termina em `/exec`).
4. Recarregue a planilha. No menu **Separação OP**: rode **1. Preparar planilha** e depois **2. Mostrar PIN de acesso**.

## 3. Usar
Abra o site do GitHub Pages, cole a URL e o PIN (uma vez por dispositivo) e toque em Conectar. Compartilhe URL do site + PIN com a equipe.
Ao alterar o `Code.gs`: **Implantar ▸ Gerenciar implantações ▸ editar ▸ Nova versão**.

## Notas
- O PIN fica só nas propriedades do script e no navegador de cada usuário; o repositório não contém segredos.
- Cronômetro por timestamps no IndexedDB, fila offline idempotente por ID de evento, `LockService` no servidor. Desenvolvimento: `npm install`, `npm run dev`, `npm test`.

## Listas editáveis (tipo da OP, conferentes, motivos)
Na aba **CONFIGURACOES**, edite a coluna B das chaves `TIPOS_OP`, `CONFERENTES` e `MOTIVOS_IMPACTO` (itens separados por `;`). O app lê a lista toda vez que abre a tela, sem precisar publicar nada. Depois de atualizar o `Code.gs`, rode **Separação OP ▸ 1. Preparar planilha** (cria as colunas TIPO_OP e CONFERENTE e as chaves que faltam, sem apagar o que você editou) e crie uma **nova versão** da implantação.
