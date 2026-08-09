create table if not exists grupo_cliente_creditos (
  id serial primary key,
  grupo_cliente_id integer not null references grupo_cliente(id),
  estado varchar(20) not null default 'ABIERTO',
  fecha_inicio date not null default current_date,
  fecha_fin date,
  forma_pago_id integer references formas_pago(id),
  pagado_en timestamp,
  pagado_por_usuario_id integer references usuarios(id),
  pagado_por varchar(120),
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  constraint grupo_cliente_creditos_estado_check check (estado in ('ABIERTO', 'PAGADO'))
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'lavados'
      and column_name = 'grupo_cliente_credito_id'
  ) then
    alter table lavados add column grupo_cliente_credito_id integer references grupo_cliente_creditos(id);
  end if;
end $$;

create unique index if not exists grupo_cliente_creditos_un_abierto
  on grupo_cliente_creditos (grupo_cliente_id)
  where estado = 'ABIERTO';

create index if not exists grupo_cliente_creditos_grupo_estado_idx
  on grupo_cliente_creditos (grupo_cliente_id, estado);

create index if not exists lavados_grupo_cliente_credito_idx
  on lavados (grupo_cliente_credito_id);

insert into grupo_cliente_creditos (grupo_cliente_id, estado, fecha_inicio, creado_por)
select c.grupo_cliente_id, 'ABIERTO', min(l.creado_en::date), 'Migracion'
from lavados l
join clientes c on c.id = l.cliente_id
join grupo_cliente g on g.id = c.grupo_cliente_id
where l.estado = 'CREDITO'
  and l.grupo_cliente_credito_id is null
  and c.grupo_cliente_id is not null
  and g.es_credito = true
  and not exists (
    select 1
    from grupo_cliente_creditos gcc
    where gcc.grupo_cliente_id = c.grupo_cliente_id
      and gcc.estado = 'ABIERTO'
  )
group by c.grupo_cliente_id;

update lavados l
set grupo_cliente_credito_id = gcc.id
from clientes c
join grupo_cliente_creditos gcc on gcc.grupo_cliente_id = c.grupo_cliente_id
where c.id = l.cliente_id
  and l.estado = 'CREDITO'
  and l.grupo_cliente_credito_id is null
  and gcc.estado = 'ABIERTO';
