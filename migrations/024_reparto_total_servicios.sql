with reparto as (
  select l.creado_en::date as fecha,
         lp.personal_id,
         lp.comision,
         floor(round(l.total * 100) / count(*) over (partition by lp.lavado_id))
           + case when row_number() over (partition by lp.lavado_id order by lp.id) = 1
               then mod(round(l.total * 100), count(*) over (partition by lp.lavado_id)) else 0 end as total_servicios_centavos
  from lavados l
  join lavado_personal lp on lp.lavado_id = l.id
  where l.estado <> 'ANULADO'
), agregados as (
  select fecha,
         personal_id,
         count(*)::int as total_lavados_emitidos,
         sum(total_servicios_centavos) / 100.0 as total_servicios,
         sum(comision) as total_comision_40
  from reparto
  group by fecha, personal_id
)
update comisiones_diarias cd
set total_lavados_emitidos = coalesce(a.total_lavados_emitidos, 0),
    total_servicios = coalesce(a.total_servicios, 0),
    total_comision_40 = coalesce(a.total_comision_40, 0)
from agregados a
where cd.fecha = a.fecha
  and cd.personal_id = a.personal_id;

update comisiones_diarias cd
set total_lavados_emitidos = 0,
    total_servicios = 0,
    total_comision_40 = 0
where not exists (
  select 1
  from lavados l
  join lavado_personal lp on lp.lavado_id = l.id
  where l.estado <> 'ANULADO'
    and l.creado_en::date = cd.fecha
    and lp.personal_id = cd.personal_id
);

with reparto as (
  select l.creado_en::date as fecha,
         lp.personal_id,
         lp.comision,
         floor(round(l.total * 100) / count(*) over (partition by lp.lavado_id))
           + case when row_number() over (partition by lp.lavado_id order by lp.id) = 1
               then mod(round(l.total * 100), count(*) over (partition by lp.lavado_id)) else 0 end as total_servicios_centavos
  from lavados l
  join lavado_personal lp on lp.lavado_id = l.id
  where l.estado <> 'ANULADO'
), agregados as (
  select fecha,
         personal_id,
         count(*)::int as total_lavados_emitidos,
         sum(total_servicios_centavos) / 100.0 as total_servicios,
         sum(comision) as total_comision_40
  from reparto
  group by fecha, personal_id
)
insert into comisiones_diarias
  (fecha, personal_id, total_lavados_emitidos, total_servicios, total_comision_40, creado_por)
select a.fecha, a.personal_id, a.total_lavados_emitidos, a.total_servicios, a.total_comision_40, 'MIGRACION 024'
from agregados a
where not exists (
  select 1
  from comisiones_diarias cd
  where cd.fecha = a.fecha
    and cd.personal_id = a.personal_id
);
