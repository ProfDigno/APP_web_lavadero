create table if not exists usuarios (
  id serial primary key,
  login varchar(50) not null unique,
  password_hash varchar(255) not null,
  nombre varchar(120) not null,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists grupo_cliente (
  id serial primary key,
  nombre varchar(120) not null unique,
  es_credito boolean not null default false,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists clientes (
  id serial primary key,
  chapa varchar(30) not null unique,
  marca_modelo varchar(150) not null,
  ruc varchar(40),
  nombre varchar(150),
  direccion varchar(200),
  telefono varchar(60),
  grupo_cliente_id integer references grupo_cliente(id),
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists servicio_grupo (
  id serial primary key,
  creado_en timestamp not null default now(),
  nombre varchar(120) not null unique,
  imagen varchar(255),
  activo boolean not null default true,
  creado_por varchar(120) not null default 'Sistema'
);

create table if not exists servicios (
  id serial primary key,
  servicio_grupo_id integer references servicio_grupo(id),
  nombre varchar(120) not null,
  precio_base numeric(12,2) not null default 0,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  unique (servicio_grupo_id, nombre)
);

create table if not exists personal (
  id serial primary key,
  nombre varchar(120) not null unique,
  telefono varchar(60),
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists formas_pago (
  id serial primary key,
  nombre varchar(60) not null unique,
  icono_ruta varchar(200),
  color varchar(30),
  mostrar_despues_crear boolean not null default true,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists lavados (
  id serial primary key,
  cliente_id integer not null references clientes(id),
  personal_id integer not null references personal(id),
  condicion varchar(20) not null check (condicion in ('CONTADO', 'CREDITO')),
  forma_pago_id integer not null references formas_pago(id),
  estado varchar(20) not null default 'EMITIDO' check (estado in ('EMITIDO', 'CREDITO', 'PAGADO', 'ANULADO')),
  total numeric(12,2) not null default 0,
  comision_personal numeric(12,2) not null default 0,
  saldo_lavadero numeric(12,2) not null default 0,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  anulado_en timestamp,
  anulado_por varchar(120)
);

create table if not exists lavado_servicios (
  id serial primary key,
  lavado_id integer not null references lavados(id) on delete cascade,
  servicio_id integer not null references servicios(id),
  precio numeric(12,2) not null,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null
);

create table if not exists comisiones_diarias (
  id serial primary key,
  fecha date not null,
  personal_id integer not null references personal(id),
  total_lavados_emitidos integer not null default 0,
  total_servicios numeric(12,2) not null default 0,
  total_comision_40 numeric(12,2) not null default 0,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  unique (fecha, personal_id)
);
