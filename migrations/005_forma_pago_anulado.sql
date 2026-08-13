insert into formas_pago (nombre, icono_ruta, color, mostrar_despues_crear, activo, creado_por)
values ('ANULADO', 'cross', '#6b7280', false, true, 'Sistema')
on conflict (nombre) do update set
  activo = true;

update lavados
set forma_pago_id = (select id from formas_pago where nombre = 'ANULADO')
where estado = 'ANULADO'
  and exists (select 1 from formas_pago where nombre = 'ANULADO');
