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
3. Ainda no SQL Editor, libere a sua conta de supervisor (troque pelo seu e-mail Google e nome):
   ```sql
   insert into acessos (email, nome, papel) values ('seu.email@gmail.com', 'Seu Nome', 'supervisor');
   ```
   As outras contas (celulares e outros supervisores) você libera depois, pelo painel.
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
0. **Frentistas**: cadastre cada frentista com um **PIN de 4 números**. É com o nome e o PIN que ele entra no app.
1. **Acessos**: libere o e-mail Google do celular do posto, como "Celular do posto".
2. **Cadastros**:
   - tanques: capacidade e saldo medido no dia da implantação;
   - bombas: encerrante lido no dia da implantação;
   - veículos e motoristas: importe os CSV exportados do KMM (`placa;capacidade_tanque_l;ultimo_km` e `nome;cpf`).

**No celular do posto:**
1. Abra no Chrome o link da release e baixe o `abastecimento-diesel.apk`.
2. Quando o Android pedir, permita **instalar apps desta fonte** para o Chrome. Depois instale.
3. Abra o app → **Entrar com Google** → escolha a conta do posto. Ele fica logado.
4. O celular precisa ter **bloqueio de tela** (senha ou digital).

## Cuidados com o plano gratuito do Supabase

- **Pausa por inatividade:** projeto gratuito sem nenhum uso por 7 dias é pausado. Com o posto lançando todo dia isso não acontece; se acontecer, é só clicar em **Restore** no painel do Supabase.
- **Sem backup automático acessível:** no plano gratuito não há como restaurar uma cópia de dias anteriores. Faça uma **exportação para Excel** pelo painel toda semana (aba Abastecimentos → Exportar). Se o sistema virar essencial, o plano Pro (cerca de US$ 25/mês) tem backup diário.
- **Espaço:** 500 MB, suficiente para muitos anos de abastecimentos.

## Atualizar o app depois de instalado

O app se atualiza sozinho. Cada mudança enviada ao GitHub publica um pacote novo das telas junto com o painel. Ao abrir, o app confere, baixa em segundo plano e, **na próxima abertura**, já está com a versão nova. Se a versão nova não conseguir abrir, ele volta sozinho para a anterior.

Só é preciso instalar um APK novo quando mudar algo da "casca" do app: ícone, nome, permissões ou componentes do Android. Nesse caso, crie uma release nova (`v1.2.0`, …) e instale por cima.

## Atualizar o banco

Quando o `supabase/schema.sql` mudar, rode o arquivo inteiro de novo no SQL Editor. Ele só cria o que falta e atualiza as regras; nenhum dado é apagado.
