create table if not exists telegram_autorizaciones (
  chat_id varchar(80) primary key,
  nombre_usuario varchar(120),
  nombre_visible varchar(200),
  autorizado_en timestamp not null default now(),
  ultimo_acceso timestamp not null default now(),
  activo boolean not null default true
);
