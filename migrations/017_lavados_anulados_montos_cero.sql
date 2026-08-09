update lavados
set total = 0,
    comision_personal = 0,
    saldo_lavadero = 0
where estado = 'ANULADO'
  and (total <> 0 or comision_personal <> 0 or saldo_lavadero <> 0);
