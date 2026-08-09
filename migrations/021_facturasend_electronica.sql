create table if not exists facturasend_config (
  id serial primary key,
  base_url varchar(240) not null,
  tenant varchar(120) not null,
  api_key_encrypted text not null,
  params jsonb not null default '{}'::jsonb,
  ambiente jsonb not null default '{}'::jsonb,
  config_set_api jsonb not null default '{}'::jsonb,
  kude_params jsonb not null default '{}'::jsonb,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  actualizado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'tipo_factura') then
    alter table facturas add column tipo_factura varchar(20) not null default 'PREIMPRESA';
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_estado') then
    alter table facturas add column electronica_estado varchar(40);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_lote_id') then
    alter table facturas add column electronica_lote_id varchar(80);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_cdc') then
    alter table facturas add column electronica_cdc varchar(80);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_numero') then
    alter table facturas add column electronica_numero varchar(80);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_facturasend_id') then
    alter table facturas add column electronica_facturasend_id varchar(80);
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_respuesta') then
    alter table facturas add column electronica_respuesta jsonb;
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'facturas' and column_name = 'electronica_enviado_en') then
    alter table facturas add column electronica_enviado_en timestamp;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'facturas_tipo_factura_check'
  ) then
    alter table facturas
      add constraint facturas_tipo_factura_check
      check (tipo_factura in ('PREIMPRESA', 'ELECTRONICA'));
  end if;
end $$;

create index if not exists facturas_electronica_cdc_idx on facturas (electronica_cdc);
create index if not exists facturasend_config_activo_idx on facturasend_config (activo);
