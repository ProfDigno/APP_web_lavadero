create table if not exists usuario_roll (
  id serial primary key,
  usuario_id integer not null unique references usuarios(id) on delete cascade,
  roll varchar(80) not null check (btrim(roll) <> ''),
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null default 'Sistema'
);

create index if not exists usuario_roll_roll_idx on usuario_roll (roll);

create table if not exists usuario_roll_item (
  id serial primary key,
  usuario_roll_id integer not null references usuario_roll(id) on delete cascade,
  codigo_item varchar(100) not null,
  nombre varchar(150) not null,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null default 'Sistema',
  unique (usuario_roll_id, codigo_item)
);

do $index_migration$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'usuario_roll_item'
      and column_name = 'codigo_item'
  ) then
    create index if not exists usuario_roll_item_codigo_idx on usuario_roll_item (codigo_item);
  end if;
end
$index_migration$;

create table if not exists usuario_roll_evento (
  id serial primary key,
  usuario_roll_id integer not null references usuario_roll(id) on delete cascade,
  nombre varchar(150) not null,
  descripcion varchar(500),
  codigo_evento varchar(120) not null,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null default 'Sistema',
  unique (usuario_roll_id, codigo_evento)
);

create index if not exists usuario_roll_evento_codigo_idx on usuario_roll_evento (codigo_evento);
