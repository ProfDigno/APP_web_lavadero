do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'clientes' and column_name = 'email'
  ) then
    alter table clientes add column email varchar(160);
  end if;
end $$;
