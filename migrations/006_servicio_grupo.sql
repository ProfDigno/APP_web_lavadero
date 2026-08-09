create table if not exists servicio_grupo (
  id serial primary key,
  creado_en timestamp not null default now(),
  nombre varchar(120) not null unique,
  imagen varchar(255),
  activo boolean not null default true,
  creado_por varchar(120) not null default 'Sistema'
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'servicios'
      and column_name = 'servicio_grupo_id'
  ) then
    alter table servicios
      add column servicio_grupo_id integer references servicio_grupo(id);
  end if;
end $$;
