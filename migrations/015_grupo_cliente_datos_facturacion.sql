do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'grupo_cliente' and column_name = 'razon_social'
  ) then
    alter table grupo_cliente add column razon_social varchar(180);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'grupo_cliente' and column_name = 'ruc'
  ) then
    alter table grupo_cliente add column ruc varchar(40);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'grupo_cliente' and column_name = 'direccion'
  ) then
    alter table grupo_cliente add column direccion varchar(200);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'grupo_cliente' and column_name = 'telefono'
  ) then
    alter table grupo_cliente add column telefono varchar(60);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'grupo_cliente' and column_name = 'email'
  ) then
    alter table grupo_cliente add column email varchar(160);
  end if;
end $$;
