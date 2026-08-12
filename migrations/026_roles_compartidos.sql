do $migration$
begin
  if to_regclass('public.usuario_roll_legacy') is not null
     or exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'usuarios'
         and column_name = 'usuario_roll_id'
     ) then
    return;
  end if;

  execute $body$
    alter table usuario_roll rename to usuario_roll_legacy;
    alter table usuario_roll_item rename to usuario_roll_item_legacy;
    alter table usuario_roll_evento rename to usuario_roll_evento_legacy;

    create table usuario_roll (
      id serial primary key,
      roll varchar(80) not null unique,
      creado_en timestamp not null default now(),
      creado_por varchar(120) not null default 'Sistema'
    );

    alter table usuarios add column usuario_roll_id integer;

    insert into usuario_roll (roll, creado_por)
    select legacy.roll, min(legacy.creado_por)
    from usuario_roll_legacy legacy
    group by legacy.roll;

    update usuarios u
    set usuario_roll_id = ur.id
    from usuario_roll_legacy legacy
    join usuario_roll ur on ur.roll = legacy.roll
    where legacy.usuario_id = u.id;

    alter table usuarios
      add constraint usuarios_usuario_roll_fk
      foreign key (usuario_roll_id) references usuario_roll(id) on delete set null;

    create table usuario_roll_item (
      id serial primary key,
      usuario_roll_id integer not null references usuario_roll(id) on delete cascade,
      codigo_item varchar(100) not null,
      nombre varchar(150) not null,
      activo boolean not null default true,
      creado_en timestamp not null default now(),
      creado_por varchar(120) not null default 'Sistema',
      constraint usuario_roll_item_codigo_key unique (usuario_roll_id, codigo_item)
    );

    insert into usuario_roll_item (usuario_roll_id, codigo_item, nombre, activo, creado_por)
    select ur.id,
           legacy.codigo_item,
           min(legacy.nombre),
           bool_and(legacy.activo),
           min(legacy.creado_por)
    from usuario_roll_item_legacy legacy
    join usuario_roll_legacy legacy_roll on legacy_roll.id = legacy.usuario_roll_id
    join usuario_roll ur on ur.roll = legacy_roll.roll
    group by ur.id, legacy.codigo_item;

    create table usuario_roll_evento (
      id serial primary key,
      usuario_roll_id integer not null references usuario_roll(id) on delete cascade,
      nombre varchar(150) not null,
      descripcion varchar(500),
      codigo_evento varchar(120) not null,
      activo boolean not null default true,
      creado_en timestamp not null default now(),
      creado_por varchar(120) not null default 'Sistema',
      constraint usuario_roll_evento_codigo_key unique (usuario_roll_id, codigo_evento)
    );

    insert into usuario_roll_evento (usuario_roll_id, nombre, descripcion, codigo_evento, activo, creado_por)
    select ur.id,
           min(legacy.nombre),
           min(legacy.descripcion),
           legacy.codigo_evento,
           bool_and(legacy.activo),
           min(legacy.creado_por)
    from usuario_roll_evento_legacy legacy
    join usuario_roll_legacy legacy_roll on legacy_roll.id = legacy.usuario_roll_id
    join usuario_roll ur on ur.roll = legacy_roll.roll
    group by ur.id, legacy.codigo_evento;

    drop table usuario_roll_evento_legacy;
    drop table usuario_roll_item_legacy;
    drop table usuario_roll_legacy;

    create index usuario_roll_item_codigo_idx on usuario_roll_item (codigo_item);
    create index usuario_roll_evento_codigo_idx on usuario_roll_evento (codigo_evento);
  $body$;
end
$migration$;
