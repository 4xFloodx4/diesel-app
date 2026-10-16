-- =====================================================================================
-- Rodar UMA VEZ, depois do schema.sql novo: a conta de administrador de hoje vira desenvolvedor.
-- Supabase > SQL Editor > cole este arquivo > troque o e-mail abaixo pelo seu > Run.
--
-- Para criar outro desenvolvedor no futuro, é o mesmo comando com o e-mail da pessoa
-- (a conta precisa já estar em "acessos"; se não estiver, use o insert do fim).
-- =====================================================================================

update acessos set papel = 'desenvolvedor'
 where email = lower('SEU.EMAIL@gmail.com')
returning email, nome, papel;

-- Conta que ainda não está liberada:
-- insert into acessos (email, nome, papel) values (lower('pessoa@gmail.com'), 'Nome da pessoa', 'desenvolvedor');
