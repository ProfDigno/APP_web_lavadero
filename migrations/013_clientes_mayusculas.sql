update clientes
set
  chapa = upper(chapa),
  marca_modelo = upper(marca_modelo),
  ruc = nullif(upper(coalesce(ruc, '')), ''),
  nombre = nullif(upper(coalesce(nombre, '')), ''),
  direccion = nullif(upper(coalesce(direccion, '')), ''),
  telefono = nullif(upper(coalesce(telefono, '')), '');
