create table if not exists gasto_tipo (
  id serial primary key,
  nombre varchar(120) not null unique,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists gastos (
  id serial primary key,
  gasto_tipo_id integer not null references gasto_tipo(id),
  fecha_gasto date not null,
  descripcion varchar(250),
  monto numeric(12,2) not null default 0,
  forma_pago_id integer not null references formas_pago(id),
  estado varchar(20) not null default 'EMITIDO' check (estado in ('EMITIDO', 'ANULADO')),
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  anulado_en timestamp,
  anulado_por varchar(120)
);

create index if not exists gastos_fecha_tipo_idx
  on gastos (fecha_gasto, gasto_tipo_id);
