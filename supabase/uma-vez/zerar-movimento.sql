-- =====================================================================================
-- ZERAR O MOVIMENTO: apaga para sempre abastecimentos, chegadas de diesel, aberturas e fechamentos, aferições, preços do diesel,
-- lotes, fotos de movimento e o histórico. Os números dos abastecimentos (Nº da requisição) voltam a começar do 1.
--
-- FICAM: veículos, motoristas, vínculos placa-motorista, frentistas e PINs, tanques, bombas, contas (acessos),
-- horário do turno e as fotos dos veículos.
--
-- Não tem como desfazer. No plano gratuito do Supabase não há backup para voltar.
-- Antes de rodar: no painel, exporte os abastecimentos para Excel, se quiser guardar.
--
-- Como rodar: Supabase > SQL Editor > cole este arquivo inteiro > troque NAO por SIM na linha marcada > Run.
-- =====================================================================================

do $$
declare
  confirmo constant text := 'NAO';   -- <<< troque NAO por SIM para zerar
  r record;
begin
  if confirmo <> 'SIM' then
    raise exception 'Nada foi apagado. Para zerar o movimento, troque NAO por SIM na linha marcada e rode de novo.';
  end if;
  for r in select 'abastecimentos' t, count(*) n from abastecimentos union all select 'chegadas', count(*) from chegadas
           union all select 'fechamentos', count(*) from fechamentos union all select 'afericoes', count(*) from afericoes
           union all select 'precos_diesel', count(*) from precos_diesel union all select 'lotes', count(*) from lotes
           union all select 'fotos (sem as de veículo)', count(*) from fotos where entidade <> 'veiculo'
           union all select 'auditoria', count(*) from auditoria loop
    raise notice 'Apagando % registro(s) de %', r.n, r.t;
  end loop;
  -- TRUNCATE não passa pelos gatilhos que proíbem apagar abastecimento e histórico (e zera a numeração)
  truncate abastecimentos, lotes, chegadas, fechamentos, afericoes, precos_diesel, auditoria, aberturas, leituras_bomba restart identity;
  delete from fotos where entidade <> 'veiculo';
  delete from sessoes_frentista;                     -- todo frentista entra de novo com nome e PIN
  update veiculos set km_desde = null where km_desde is not null;
  update frentistas_pin set falhas = 0, falhas_dia = 0, dia_falhas = null, bloqueado_ate = null;
  raise notice 'Movimento zerado.';
end $$;

-- Depois de rodar, apague os arquivos de foto do movimento no Storage (o SQL não consegue apagar arquivos):
-- Supabase > Storage > fotos > marque as pastas abastecimento, abertura, afericao, chegada e fechamento > Delete.
-- Deixe a pasta "veiculo": são as fotos dos caminhões cadastrados.
-- No Google Drive, as pastas de comprovantes antigos ficam; apague a pasta Abastecimentos se não quiser guardar.
