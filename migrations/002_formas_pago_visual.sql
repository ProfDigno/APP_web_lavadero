do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'formas_pago' and column_name = 'icono_ruta'
  ) then
    alter table formas_pago add column icono_ruta varchar(200);
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'formas_pago' and column_name = 'color'
  ) then
    alter table formas_pago add column color varchar(30);
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'formas_pago' and column_name = 'mostrar_despues_crear'
  ) then
    alter table formas_pago add column mostrar_despues_crear boolean not null default true;
  end if;
end $$;
