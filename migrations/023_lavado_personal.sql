create table if not exists lavado_personal (
  id serial primary key,
  lavado_id integer not null references lavados(id) on delete cascade,
  personal_id integer not null references personal(id),
  comision numeric(12,2) not null default 0,
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  unique (lavado_id, personal_id)
);

create index if not exists lavado_personal_lavado_idx on lavado_personal (lavado_id);
create index if not exists lavado_personal_personal_idx on lavado_personal (personal_id);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'lavados' and column_name = 'personal_id'
  ) then
    insert into lavado_personal (lavado_id, personal_id, comision, creado_en, creado_por)
    select id, personal_id, comision_personal, creado_en, creado_por
    from lavados
    where personal_id is not null
    on conflict (lavado_id, personal_id) do nothing;

    alter table lavados drop constraint if exists lavados_personal_id_fkey;
    alter table lavados drop column personal_id;
  end if;
end $$;
