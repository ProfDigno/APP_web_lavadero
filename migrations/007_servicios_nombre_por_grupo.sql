alter table servicios
  drop constraint if exists servicios_nombre_key;

create unique index if not exists servicios_grupo_nombre_key
  on servicios (servicio_grupo_id, nombre);
