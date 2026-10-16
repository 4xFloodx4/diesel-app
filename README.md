# Abastecimento Diesel

Lançamento de diesel do posto interno sem folha de papel e sem redigitação no KMM.

- **App Android do frentista:** fica logado com a conta Google do posto. Em cada lançamento, o frentista escolhe o próprio nome. As conferências aparecem na hora: KM, capacidade do tanque (1100 L por padrão), encerrante × litros e repetição. Todo abastecimento leva uma foto do comprovante junto com o visor da bomba, guardada no Google Drive. Precisa de internet para lançar: nada fica guardado só no celular. Conta de supervisor ou administrador abre o painel no próprio app, em versão de celular.
- **Painel web do supervisor:** abre em qualquer computador, com login Google. Tem visão do dia, decisões (autorizações e exceções), a planilha no formato do importador do KMM, tanques e fechamentos, cadastros, contas liberadas, auditoria em linguagem simples e guia de uso. Tema claro, escuro ou automático; no celular o menu vira uma gaveta à esquerda.
- **Banco no Supabase:** as conferências rodam dentro do banco, e o celular não grava nada sem passar por elas.

Para colocar no ar: [docs/CONFIGURAR.md](docs/CONFIGURAR.md).

## Segurança

| Risco | Proteção |
|---|---|
| Frentista lançando em nome de outro | Cada um entra com nome + PIN de 4 números; 5 erros bloqueiam por 5 minutos; 15 erros no dia bloqueiam até o supervisor definir um PIN novo; o PIN fica guardado só como hash, nem o supervisor vê |
| Lançamento sem desconto do motorista | Só entra com justificativa e fica parado até o supervisor autorizar |
| Supervisor mexendo onde não deve | Só gerencia celulares, frentistas e cadastros; administradores só o dono do projeto altera; ações de administradores não aparecem para ele na auditoria |
| Foto trocada depois | Fotos ficam num bucket privado; ninguém altera; só supervisor e administrador excluem, e a exclusão fica na auditoria. Os comprovantes dos abastecimentos passam para uma pasta do Google Drive (só a conta dona e quem ela convidar enxergam) |
| Lançamento fora do horário ou depois do fechamento | Fora do turno (definido pelo administrador) só entra com justificativa e autorização; depois do fechamento do dia, nada mais entra com aquela data |
| Conta Google qualquer tentar entrar | Só e-mails liberados em **Acessos** veem ou gravam algo (RLS em todas as tabelas). Só vale login Google |
| Celular perdido | Supervisor bloqueia a conta em Acessos; o acesso cai na próxima tentativa |
| Celular gravando direto no banco ou mexendo em cadastro | O papel "posto" não tem permissão em tabela nenhuma; só nas funções de registrar, que conferem tudo |
| Dado errado vindo do celular | O banco refaz todas as conferências; a do celular é só para o frentista ver na hora |
| Lançar em dobro no KMM | Cada registro tem identificador único; reenvio não duplica; registro em lote não entra em outro |
| Apagar ou adulterar | Abastecimento não pode ser apagado (só cancelado com motivo); depois de ir ao KMM não muda mais; auditoria não pode ser alterada |
| CPF exposto | CPF não vai para o celular; no painel aparece mascarado; no histórico também |
| Código malicioso na página | Política de conteúdo (CSP): só scripts, estilos e fontes do próprio app (sem estilo inline); rede só para o Supabase do projeto; todo texto vindo do banco é escapado |
| Painel aberto escondido dentro de outro site | As páginas se recusam a abrir dentro de moldura (iframe) |
| Modo demonstração gravando dado falso | Só o administrador liga; enquanto ligado, nenhuma ação é enviada ao banco |
| Backup do celular vazar a sessão | Backup do app desativado no Android |

## Estrutura

| Pasta | O que tem |
|---|---|
| `supabase/schema.sql` | Tabelas, regras de acesso e conferências. Roda no SQL Editor do Supabase |
| `web/app/` | Telas do frentista (viram o APK) |
| `web/painel/` | Painel do supervisor (vira o site no GitHub Pages) |
| `web/comum/` | Login, conexão, formatação e planilha do KMM |
| `scripts/` | Geração do site e ajuste do projeto Android |
| `tests/` | Testes do banco (PostgreSQL real, via PGlite) e da planilha do KMM |
| `.github/workflows/` | Publicação automática do painel e geração do APK |

## Comandos

```
npm install
npm test                 # testes do banco e da planilha
npm run build            # gera dist/ (site) e dist-android/ (APK); precisa de config.local.json ou variáveis
node scripts/build.mjs --demo   # gera sem Supabase de verdade, só para ver as telas
```

`config.local.json` (não vai para o GitHub):
```json
{ "SUPABASE_URL": "https://xxxx.supabase.co", "SUPABASE_ANON_KEY": "eyJ..." }
```

## Planilha do KMM

O layout é o do assistente "Importação de abastecimento > Interno" do KMM 3.23.1, conferido com o modelo oficial `Modelo Importacao Abastecimento Interno.xls`. Ainda falta testar a importação de verdade. Comportamentos do validador do KMM a confirmar nesse teste:
- arquivo com exatamente 1 linha de dados é recusado;
- a checagem de colunas espera 11, mas o layout tem 12.
