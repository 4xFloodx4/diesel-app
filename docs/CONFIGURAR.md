# Configurar do zero

Passo a passo para colocar o sistema no ar. Faça na ordem: cada etapa usa algo da anterior. Leva cerca de 1 a 2 horas na primeira vez.

Você vai precisar de:
- uma conta no **GitHub** (github.com), onde fica o código, o painel e o APK;
- uma conta no **Supabase** (supabase.com), onde ficam os dados;
- uma conta **Google** para criar o login (pode ser a mesma do posto ou a sua);
- o e-mail Google que vai ficar logado no celular do posto e o seu e-mail Google de supervisor.

## 1. Supabase: banco de dados

1. Em supabase.com, crie um projeto. Região: **South America (São Paulo)**. Guarde a senha do banco num lugar seguro.
2. Menu **SQL Editor** → **New query** → cole todo o conteúdo de `supabase/schema.sql` → **Run**. Deve terminar com "Success".
3. Ainda no SQL Editor, libere a sua conta como **desenvolvedor** (troque pelo seu e-mail Google e nome):
   ```sql
   insert into acessos (email, nome, papel) values ('seu.email@gmail.com', 'Seu Nome', 'desenvolvedor');
   ```
   As outras contas você libera depois, pelo painel, em **Acessos**. Cargos, do maior para o menor:
   - **Desenvolvedor:** tudo, inclusive o banco de dados pelo painel e criar administradores. Outro desenvolvedor só por este SQL.
   - **Administrador** (o analista): fecha o turno no KMM, ajusta horário e regras, libera celulares e supervisores.
   - **Supervisor:** decisões, cadastros, frentistas e PIN. Não libera contas.
   - **Celular do posto:** a conta Google do celular, onde cada frentista entra com nome e PIN.

   Sistema que já estava no ar, com a sua conta como administrador: rode `supabase/uma-vez/virar-desenvolvedor.sql` (com o seu e-mail) depois do `schema.sql`.
4. Menu **Project Settings** → **API**: copie a **Project URL** (`https://xxxx.supabase.co`) e a chave **anon public**. Você vai usar as duas no passo 4.

## 2. Google: login

1. Acesse console.cloud.google.com e crie um projeto (ex.: "Diesel").
2. **APIs e serviços** → **Tela de permissão OAuth**:
   - Tipo: **Externo** (ou **Interno**, se a empresa usa Google Workspace).
   - Nome do app: "Abastecimento Diesel"; e-mail de suporte: o seu.
   - Escopos: os básicos (e-mail e perfil), sem nada extra.
   - Depois de salvar, clique em **Publicar app**. Em modo "Teste" só entram contas adicionadas manualmente.
3. **Credenciais** → **Criar credenciais** → **ID do cliente OAuth** → tipo **Aplicativo da Web**.
   - Em **URIs de redirecionamento autorizados**, adicione: `https://xxxx.supabase.co/auth/v1/callback` (com o endereço do seu projeto Supabase).
   - Copie o **ID do cliente** e a **Chave secreta do cliente**.
4. De volta ao Supabase, **Authentication** → **Sign In / Providers**:
   - **Google**: ative e cole o ID e a chave secreta.
   - **Email**: **desative**. O sistema só aceita login Google; deixar e-mail ligado abriria outra porta.

## 3. GitHub: código e site

1. Em github.com, crie um repositório chamado `diesel-app`.
   - **Público** é o necessário para o site (GitHub Pages) no plano gratuito. Só o código fica visível: nenhum dado, senha ou chave secreta está nele. A chave "anon" do Supabase é pública por natureza; quem protege os dados são as regras do banco.
   - Se a empresa preferir **privado**, o GitHub Pages exige o plano pago (GitHub Pro ou Team).
2. Envie esta pasta para o repositório. No PowerShell, dentro de `D:\diesel-app`:
   ```
   git remote add origin https://github.com/SEU-USUARIO/diesel-app.git
   git push -u origin main
   ```
   Na primeira vez abre uma janela para entrar no GitHub.
3. No repositório: **Settings** → **Pages** → em "Source", escolha **GitHub Actions**.
4. Anote o endereço do painel: `https://SEU-USUARIO.github.io/diesel-app/painel/`

## 4. Ligar tudo

**No GitHub**, em **Settings** → **Secrets and variables** → **Actions**:
- Aba **Variables** → **New repository variable**:
  - `SUPABASE_URL` = a Project URL do passo 1
  - `SUPABASE_ANON_KEY` = a chave anon public do passo 1
- Aba **Secrets**: veja o passo 5.

**No Supabase**, em **Authentication** → **URL Configuration**:
- **Site URL**: `https://SEU-USUARIO.github.io/diesel-app/painel/`
- **Redirect URLs**, adicione as três:
  - `https://SEU-USUARIO.github.io/diesel-app/painel/`
  - `https://SEU-USUARIO.github.io/diesel-app/app/`
  - `br.com.ritmolog.diesel://login` (é por onde o login volta para o app Android)

Depois disso, em **Actions** no GitHub, rode de novo o "Publicar painel" (botão **Run workflow**) para o site pegar as variáveis.

## 5. Chave de assinatura do APK

O Android só aceita atualizar um app se a nova versão vier assinada com a **mesma chave** da primeira. Crie a chave uma vez e guarde bem.

No PowerShell (troque a senha por uma forte, com 12 caracteres ou mais):
```
cd D:\
keytool -genkeypair -v -keystore diesel.jks -alias diesel -keyalg RSA -keysize 3072 -validity 10000 -storepass "SUA-SENHA-FORTE" -keypass "SUA-SENHA-FORTE" -dname "CN=Abastecimento Diesel"
[Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\diesel.jks")) | Set-Clipboard
```
O último comando copia a chave, já convertida em texto, para a área de transferência. No GitHub, aba **Secrets** → **New repository secret**:
- `KEYSTORE_BASE64` = cole (Ctrl+V)
- `KEYSTORE_SENHA` = a senha que você usou

Guarde `D:\diesel.jks` e a senha **fora do computador** (pen drive guardado, cofre de senhas da empresa). Não coloque o arquivo no repositório. Se perder a chave, as próximas versões do app não instalam por cima: vai ser preciso desinstalar e instalar de novo em cada celular.

## 6. Gerar o APK

- **Versão oficial:** no GitHub, **Releases** → **Draft a new release** → crie a tag `v1.0.0` → **Publish**. Em alguns minutos o `abastecimento-diesel.apk` aparece anexado nessa release.
- **Teste rápido:** **Actions** → **Gerar APK** → **Run workflow**. O APK fica em "Artifacts", no fim da página da execução.

Para atualizar o app depois, crie uma nova release com tag maior (`v1.0.1`, `v1.1.0`…).

## 7. Primeiro uso

**No painel** (`https://SEU-USUARIO.github.io/diesel-app/painel/`), entre com a sua conta Google de supervisor:
0. **Horário e regras** (administrador, em Sistema): o turno padrão é das 05:00 às 23:00; fora dele, o lançamento precisa de justificativa e autorização. As regras da conferência (salto de KM, folga do encerrante, régua, aferição, tanque padrão de 1100 L) já vêm com valores comuns; ajuste só se precisar.
1. **Frentistas**: cadastre cada frentista com um **PIN de 4 números**. É com o nome e o PIN que ele entra no app.
2. **Acessos**: libere o e-mail Google do celular do posto, como "Celular do posto".
3. **Cadastros** (Tanques e fechamentos; Veículos e motoristas):
   - tanques: capacidade e saldo medido no dia da implantação;
   - bombas: encerrante lido no dia da implantação. Posto com 1 tanque e 2 bombas: cadastre o tanque (ex.: `TQ01`) e as bombas 1 e 2, as duas ligadas a `TQ01`, cada uma com o próprio encerrante. No app, o frentista escolhe a bomba a cada lançamento, e o fechamento soma o que saiu pelas duas;
   - veículos e motoristas: o tanque do caminhão já vem com **1100 L**; só mude o que for diferente. Em **Veículos e motoristas › Base em Excel**, importe a planilha com as abas `Veiculos` (placa, capacidade_tanque_l, km_inicial, ativo), `Motoristas` (nome, cpf, ativo) e `Vinculos` (placa, motorista, cpf). O mais fácil é clicar em **Exportar base**, preencher e importar de volta. Os CSV do KMM (`placa;capacidade_tanque_l;ultimo_km` e `nome;cpf`) também são aceitos.

**No celular do posto:**
1. Abra no Chrome o link da release e baixe o `abastecimento-diesel.apk`.
2. Quando o Android pedir, permita **instalar apps desta fonte** para o Chrome. Depois instale.
3. Abra o app → **Entrar com Google** → escolha a conta do posto. Ele fica logado.
4. O celular precisa ter **bloqueio de tela** (senha ou digital).

## 8. Comprovantes no Google Drive

Todo abastecimento leva uma foto do comprovante junto com o visor da bomba. O app manda a foto para o Supabase, que só segura até ela ir para o Drive. Um script do Google, na sua conta, leva as fotos a cada 10 minutos para:

```
Abastecimentos/
  2026-10/
    16/
      Comprovante-ABC1D23-1432.jpg
      Abertura-0458-1.jpg
      Fechamento-2305-1.jpg
Aferições/
  2026/
    Semana 42 (12-10 a 18-10)/
      Bomba-1-16-10-0712-1.jpg
      Bomba-1-16-10-0712-2.jpg
```

A pasta **Aferições** fica ao lado de **Abastecimentos** (na mesma pasta-mãe) e é criada sozinha. Cada semana vai de segunda a domingo; cada aferição leva de 1 a 5 fotos.

O arquivo tem a placa e a hora do abastecimento. O mesmo caminhão duas vezes no mesmo minuto vira `-2`. O painel abre a foto pelo link do Drive, no botão **Ver** da lista de abastecimentos e em **Ver comprovante** nas decisões.

Espaço: com cerca de 25 abastecimentos por dia, dá uns 250 MB por mês. Os 15 GB do Drive grátis guardam alguns anos. O Drive não apaga nada sozinho.

**Instalar (uma vez):**
1. Rode o `supabase/schema.sql` novo no SQL Editor (veja "Atualizar o banco").
2. No Supabase, **Project Settings** → **API Keys**: copie a chave **service_role** (ou a **secret**, se o projeto usa as chaves novas). Ela abre o banco todo: só vai no passo 4, nunca no código, no GitHub ou em mensagem.
3. Entre em **script.google.com** com a conta Google que vai guardar as fotos → **Novo projeto** → apague o que estiver lá, cole todo o conteúdo de `scripts/drive-comprovantes.gs` e salve (Ctrl+S). Dê um nome, como "Comprovantes diesel".
4. Engrenagem **Configurações do projeto** → **Propriedades do script** → **Adicionar propriedade de script**:
   - `SUPABASE_URL` = `https://xxxx.supabase.co` (o mesmo do passo 1)
   - `SUPABASE_SERVICE_KEY` = a chave do passo 2
   - `PASTA_ID` (opcional) = o ID de uma pasta que já exista (o que vem depois de `/folders/` no endereço). Sem ele, o script cria **Abastecimentos** no Meu Drive.
5. Volte ao **Editor**, escolha a função **instalar** no alto e clique em **Executar**. Na primeira vez o Google pede autorização: escolha a conta, **Avançado** → **Acessar (não seguro)** → **Permitir**. O aviso aparece porque o script é seu e não foi publicado; ele só mexe no seu Drive e fala com o seu Supabase.
6. Em **Execuções** deve aparecer "Ligação com o Supabase OK". Pronto: o gatilho de 10 em 10 minutos ficou criado (em **Acionadores**).

**Ver as fotos pelo painel:** compartilhe as pastas **Abastecimentos** e **Aferições** no Drive com a conta Google de cada supervisor, como **Leitor**. Quem não tem acesso vê o botão **Abrir no Google Drive**, mas o Drive pede permissão.

**Se algo falhar:** o Google manda um e-mail quando uma execução dá erro. As fotos que não foram ficam no Supabase e vão na próxima rodada, então nada se perde. Se o script ficar parado, as fotos se acumulam no Supabase (1 GB grátis, uns 3 meses), por isso confira **Execuções** de vez em quando.

## 9. Relatório diário em PDF

Depois que o frentista fecha o turno, o mesmo script do passo 8 preenche o modelo **RELATÓRIO DIÁRIO DE ABASTECIMENTO - VERSÃO ONLINE** e salva o PDF na pasta do dia (`Abastecimentos/2026-10/16/Relatorio-diario-16-10.pdf`). O painel abre o PDF em **Exportar › Relatório diário** e no cartão do turno. A assinatura fica em branco, para o carimbo do analista.

**Instalar (uma vez):**
1. No Google Drive da mesma conta do script, envie o arquivo `RELATÓRIO DIÁRIO DE ABASTECIMENTO - VERSÃO ONLINE.xlsx`.
2. Clique nele com o botão direito → **Abrir com** → **Planilhas Google**. Depois **Arquivo** → **Salvar como Planilhas Google**. É essa cópia em Planilha Google que o script usa.
3. Copie o ID dela (o que vem entre `/d/` e `/edit` no endereço).
4. No script, **Configurações do projeto** → **Propriedades do script** → adicione `MODELO_ID` = o ID copiado.
5. Cole o `scripts/drive-comprovantes.gs` novo por cima do antigo e salve.
6. Execute **instalar** de novo. O Google pede uma autorização nova (agora também para planilhas): **Avançado** → **Acessar** → **Permitir**.
7. Para testar sem esperar: feche um turno no app (ou reabra e feche no painel) e execute **testarRelatorio**. Em **Execuções** aparece o link do PDF.

O modelo tem lugar para 35 abastecimentos e uma chegada de diesel. Passou disso, o PDF ganha outra folha igual. Mudou o modelo no Drive? O próximo relatório já sai com ele. Só não mude as linhas e colunas de lugar: o script escreve nas células do modelo (cabeçalho nas linhas 5 a 7, abastecimentos de 10 a 44, recebimento de 46 a 50).

## Cuidados com o plano gratuito do Supabase

- **Pausa por inatividade:** projeto gratuito sem nenhum uso por 7 dias é pausado. Com o posto lançando todo dia isso não acontece; se acontecer, é só clicar em **Restore** no painel do Supabase.
- **Sem backup automático acessível:** no plano gratuito não há como restaurar uma cópia de dias anteriores. Faça uma **exportação para Excel** pelo painel toda semana (aba Abastecimentos → Exportar). Se o sistema virar essencial, o plano Pro (cerca de US$ 25/mês) tem backup diário.
- **Espaço:** 500 MB de banco, suficiente para muitos anos de abastecimentos. As fotos têm 1 GB à parte. Os comprovantes saem dali para o Google Drive (passo 8); as outras fotos (chegada, fechamento, aferição e veículo) continuam no Supabase.

## Atualizar o app depois de instalado

O app se atualiza sozinho. Cada mudança enviada ao GitHub publica um pacote novo das telas junto com o painel. O app confere ao abrir, a cada 5 minutos e quando o celular volta para ele. Achou versão nova, baixa (aparece uma faixa "Baixando atualização" no alto) e, assim que o frentista não estiver no meio de um lançamento, mostra **Atualizando o app…** e reabre já na versão nova, com uma frase do que mudou: o título do commit. Se o app fechar antes, a versão nova entra na próxima abertura. Se ela não conseguir abrir, o app volta sozinho para a anterior.

O título do commit aparece para o frentista: escreva em português simples, como "Foto do comprovante obrigatória em todo abastecimento".

Só é preciso instalar um APK novo quando mudar algo da "casca" do app: ícone, nome, permissões ou componentes do Android. Nesse caso, crie uma release nova (`v1.2.0`, …) e instale por cima.

A vibração ao enviar e o fundo branco ao abrir (no lugar do fundo preto por um instante) só funcionam a partir de um APK gerado depois dessa mudança. Sem o APK novo, o resto funciona normalmente; só não vibra.

## Atualizar o banco

Quando o `supabase/schema.sql` mudar, rode o arquivo inteiro de novo no SQL Editor. Ele só cria o que falta e atualiza as regras; nenhum dado é apagado.

Rode **antes** de publicar telas novas que dependam dele (por exemplo, o horário do turno): as telas novas chamam colunas e funções que só existem depois.

Quando o banco passa a exigir algo novo do app (como a foto do comprovante), a versão antiga do app no celular deixa de conseguir lançar até se atualizar. Faça a troca num horário calmo: rode o SQL e publique. Em poucos minutos o app se atualiza sozinho; para não esperar, feche e abra o app.
