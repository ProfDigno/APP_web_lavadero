do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'usuario_roll'
      and column_name = 'usuario_id'
  ) then
    alter table usuario_roll rename to usuario_roll_legacy;
    alter table usuario_roll_item rename to usuario_roll_item_legacy;

    create table usuario_roll (
      id serial primary key,
      roll varchar(80) not null unique,
      activo boolean not null default true,
      creado_en timestamp not null default now(),
      creado_por varchar(120) not null default 'Sistema'
    );

    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'usuarios' and column_name = 'usuario_roll_id'
    ) then
      alter table usuarios add column usuario_roll_id integer;
    end if;

    insert into usuario_roll (roll, creado_por)
    select roll, min(creado_por)
    from usuario_roll_legacy
    group by roll;

    update usuarios u
    set usuario_roll_id = ur.id
    from usuario_roll_legacy legacy
    join usuario_roll ur on ur.roll = legacy.roll
    where legacy.usuario_id = u.id;

    if not exists (
      select 1 from pg_constraint where conname = 'usuarios_usuario_roll_fk'
    ) then
      alter table usuarios
        add constraint usuarios_usuario_roll_fk
        foreign key (usuario_roll_id) references usuario_roll(id) on delete set null;
    end if;

    create table usuario_roll_item (
      id serial primary key,
      usuario_roll_id integer not null references usuario_roll(id) on delete cascade,
      usuario_roll_evento_id integer not null references usuario_roll_evento(id) on delete set null,
      activo boolean not null default true,
      creado_en timestamp not null default now(),
      creado_por varchar(120) not null default 'Sistema',
      unique (usuario_roll_id, usuario_roll_evento_id)
    );

    insert into usuario_roll_item (usuario_roll_id, usuario_roll_evento_id, activo, creado_por)
    select ur.id, legacy.usuario_roll_evento_id, legacy.activo, legacy.creado_por
    from usuario_roll_item_legacy legacy
    join usuario_roll_legacy legacy_roll on legacy_roll.id = legacy.usuario_roll_id
    join usuario_roll ur on ur.roll = legacy_roll.roll
    where legacy.usuario_roll_evento_id is not null
    on conflict (usuario_roll_id, usuario_roll_evento_id) do nothing;

    drop table usuario_roll_item_legacy;
    drop table usuario_roll_legacy;
  end if;
end
$migration$;

create table if not exists usuario_roll (
  id serial primary key,
  roll varchar(80) not null unique,
  activo boolean not null default true,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null default 'Sistema'
);

do $migration$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'usuarios' and column_name = 'usuario_roll_id'
  ) then
    alter table usuarios add column usuario_roll_id integer;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'usuarios_usuario_roll_fk'
  ) then
    alter table usuarios
      add constraint usuarios_usuario_roll_fk
      foreign key (usuario_roll_id) references usuario_roll(id) on delete set null;
  end if;
end
$migration$;

insert into usuario_roll (roll, activo, creado_por)
values
  ('ADMINISTRADOR', true, 'Sistema'),
  ('ENCARGADO', true, 'Sistema'),
  ('CAJERO', true, 'Sistema'),
  ('LAVADOR', true, 'Sistema')
on conflict (roll) do update set activo = true;

insert into usuario_roll_evento (nombre, descripcion, codigo_evento, activo, creado_por)
values ('Bloquear servicio', 'Permite bloquear o desbloquear servicios.', 'servicio-bloqueo', true, 'Sistema')
on conflict (codigo_evento) do update set activo = true;

insert into usuario_roll_item (usuario_roll_id, usuario_roll_evento_id, activo, creado_por)
select ur.id, ure.id, true, 'Sistema'
from usuario_roll ur
cross join usuario_roll_evento ure
where ure.codigo_evento = 'servicio-bloqueo'
  and ur.roll in ('ADMINISTRADOR', 'ENCARGADO', 'CAJERO')
on conflict (usuario_roll_id, usuario_roll_evento_id) do update set activo = true;

update usuarios
set usuario_roll_id = (select id from usuario_roll where roll = 'ADMINISTRADOR')
where login = 'admin'
  and usuario_roll_id is null;
