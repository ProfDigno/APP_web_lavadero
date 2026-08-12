do $migration$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'usuario_roll'
      and column_name = 'activo'
  ) then
    alter table usuario_roll add column activo boolean not null default true;
  end if;
end
$migration$;
