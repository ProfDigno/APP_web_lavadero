alter table lavados drop constraint if exists lavados_estado_check;

alter table lavados
  add constraint lavados_estado_check
  check (estado in ('EMITIDO', 'CREDITO', 'PAGADO', 'ANULADO'));

update lavados l
set estado = case
  when fp.nombre in ('LAVADO', 'CREDITO') then 'EMITIDO'
  else 'PAGADO'
end
from formas_pago fp
where fp.id = l.forma_pago_id
  and l.estado <> 'ANULADO';
