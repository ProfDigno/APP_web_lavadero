create table if not exists facturas (
  id serial primary key,
  numero varchar(60),
  fecha_emision date not null default current_date,
  cliente_id integer references clientes(id),
  lavado_id integer references lavados(id),
  cliente_nombre varchar(180) not null,
  cliente_ruc varchar(60),
  cliente_direccion varchar(220),
  condicion varchar(20) not null default 'CONTADO' check (condicion in ('CONTADO')),
  subtotal numeric(12,2) not null default 0,
  iva_10 numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  origen varchar(20) not null check (origen in ('LAVADO', 'LIBRE')),
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists factura_items (
  id serial primary key,
  factura_id integer not null references facturas(id) on delete cascade,
  servicio_id integer references servicios(id),
  descripcion varchar(220) not null,
  cantidad numeric(12,2) not null default 1,
  precio_unitario numeric(12,2) not null default 0,
  exenta numeric(12,2) not null default 0,
  iva_5 numeric(12,2) not null default 0,
  iva_10 numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create index if not exists facturas_fecha_idx on facturas (fecha_emision);
create index if not exists facturas_lavado_idx on facturas (lavado_id);
create index if not exists factura_items_factura_idx on factura_items (factura_id);
