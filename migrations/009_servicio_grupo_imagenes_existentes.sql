update servicio_grupo
set imagen = '/uploads/servicio-grupos/auto-sedan-azul-carwash.png'
where upper(nombre) = 'AUTO'
  and (imagen is null or imagen = '');

update servicio_grupo
set imagen = '/uploads/servicio-grupos/camioneta-azul-carwash.png'
where upper(nombre) in ('CAMIONETA', 'COMIONETA')
  and (imagen is null or imagen = '');

update servicio_grupo
set imagen = '/uploads/servicio-grupos/moto-azul-carwash.png'
where upper(nombre) = 'MOTO'
  and (imagen is null or imagen = '');

update servicio_grupo
set imagen = '/uploads/servicio-grupos/auto-sedan-rojo-empresa.png'
where upper(nombre) = 'EMPRESARIAL'
  and (imagen is null or imagen = '');
