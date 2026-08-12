do $migration$
declare
  constraint_record record;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'usuario_roll_item'
      and column_name = 'usuario_roll_evento_id'
  ) then
    alter table usuario_roll_item add column usuario_roll_evento_id integer;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'usuario_roll_evento'
      and column_name = 'usuario_roll_id'
  ) then
    for constraint_record in
      select conname
      from pg_constraint
      where conrelid = 'public.usuario_roll_evento'::regclass
        and contype = 'f'
        and confrelid = 'public.usuario_roll'::regclass
    loop
      execute format('alter table usuario_roll_evento drop constraint %I', constraint_record.conname);
    end loop;

    alter table usuario_roll_evento drop constraint if exists usuario_roll_evento_codigo_key;
    alter table usuario_roll_evento drop column usuario_roll_id;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'usuario_roll_item_evento_fk'
      and conrelid = 'public.usuario_roll_item'::regclass
  ) then
    alter table usuario_roll_item
      add constraint usuario_roll_item_evento_fk
      foreign key (usuario_roll_evento_id)
      references usuario_roll_evento(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'usuario_roll_evento_codigo_key'
      and conrelid = 'public.usuario_roll_evento'::regclass
  ) then
    alter table usuario_roll_evento
      add constraint usuario_roll_evento_codigo_key unique (codigo_evento);
  end if;
end
$migration$;

create index if not exists usuario_roll_item_evento_idx
  on usuario_roll_item (usuario_roll_evento_id);
