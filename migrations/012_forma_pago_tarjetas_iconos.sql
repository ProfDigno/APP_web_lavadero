update formas_pago
set icono_ruta = '/uploads/formas-pago/tarjeta-debito-amarilla.png'
where nombre = 'TARJETA_DEBITO';

update formas_pago
set icono_ruta = '/uploads/formas-pago/tarjeta-credito-roja.png'
where nombre = 'TARJETA_CREDITO';
