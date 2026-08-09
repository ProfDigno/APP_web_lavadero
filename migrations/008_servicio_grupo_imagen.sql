do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'servicio_grupo'
      and column_name = 'imagen'
  ) then
    alter table servicio_grupo
      add column imagen varchar(255);
  end if;
end $$;
