# Configuracion para proximos CRUD

Este documento registra reglas base para crear nuevas pantallas CRUD en la app Lavadero.

## Buscador obligatorio

Todo CRUD nuevo debe incluir un buscador sobre la tabla principal.

Reglas:

- El buscador debe estar arriba de la tabla.
- Debe usar `type="search"`.
- Debe filtrar sin recargar la pagina.
- Debe buscar por ID y por los campos visibles/importantes del registro.
- Debe ignorar diferencias entre mayusculas, minusculas y acentos.
- Debe mostrar un contador de registros visibles.
- Si no hay coincidencias, debe mostrar `Sin resultados para la busqueda.`.

## Marcado HTML esperado

Usar estos atributos para aprovechar el comportamiento global de `public/js/app.js`:

```html
<div data-crud-search-scope>
  <input type="search" data-crud-search>
  <span data-crud-search-count></span>

  <tr data-crud-row data-search="texto de busqueda del registro">
    ...
  </tr>

  <tr class="is-hidden" data-crud-no-results>
    <td>Sin resultados para la busqueda.</td>
  </tr>
</div>
```

## Pantallas ya cubiertas

- Clientes
- Servicios
- Grupos de servicio
- Personal
- Grupos de cliente
- Usuarios
- Tipos de gasto
- Gastos

## Relacionados en tabla

Cuando una pantalla necesite mostrar registros relacionados al seleccionar una fila, debe mantener la tabla principal visible y desplegar el detalle debajo.

- Grupos de cliente muestra sus clientes relacionados.
- Grupos de servicio muestra sus servicios relacionados.
- Personal muestra dos pestanas: lavados y vales del personal.
- Las listas relacionadas grandes deben limitarse a 100 registros por pagina y tener Anterior/Siguiente.

## Gastos

Tablas actuales:

- `gasto_tipo`: nombre, activo, fecha de creacion.
- `gastos`: tipo de gasto, fecha de gasto, descripcion, monto, forma de pago, estado, fecha de creacion.

Reglas:

- El estado por defecto es `EMITIDO`.
- Al anular un gasto, el estado debe pasar a `ANULADO` y el monto debe quedar en `0`.
- Gasto debe usar el mismo patron visual de Vales: tabla principal, filtro por fecha, boton Nuevo y formulario emergente para crear/editar.

## Caja diaria

La caja no tiene apertura ni cierre manual. Se calcula por fecha desde movimientos reales:

- Ingresos: lavados de contado y creditos de grupo pagados.
- Egresos: gastos y vales.
- El efectivo a contar es ingresos en `EFECTIVO` menos egresos en `EFECTIVO`.
- Los movimientos anulados no deben sumar.

## Facturas

La factura no afecta caja. Se usa para imprimir sobre preimpreso Paraguay.

- Puede crearse desde lavado o como factura libre.
- El numero de factura es manual opcional.
- La condicion es siempre `CONTADO`.
- Todo item usa IVA 10%; no se usa exenta ni IVA 5.
- El formulario permite hasta 9 items para no desbordar el preimpreso.
- La factura puede editarse siempre.

## Grupos de cliente

Campos actuales:

- Nombre
- Razon social
- RUC
- Direccion
- Telefono
- Email
- Es credito
- Activo

## Clientes

Campos actuales:

- Chapa
- Marca/modelo
- RUC
- Nombre
- Direccion
- Telefono
- Email
- Grupo cliente
- Activo

Cuando se selecciona un grupo cliente al crear o editar un cliente, se deben precargar los campos parecidos si estan vacios:

- `grupo_cliente.razon_social` -> `clientes.nombre`
- `grupo_cliente.ruc` -> `clientes.ruc`
- `grupo_cliente.direccion` -> `clientes.direccion`
- `grupo_cliente.telefono` -> `clientes.telefono`
- `grupo_cliente.email` -> `clientes.email`

La misma regla aplica al crear cliente rapido desde Lavados.

## Tablas relacionadas

Al seleccionar una fila de grupo, debe mostrarse debajo la tabla de registros relacionados:

- Grupo de cliente -> clientes relacionados.
- Grupo de servicio -> servicios relacionados.

## Implementacion actual

- Vista CRUD compartida: `src/views/crud.ejs`.
- Vista de usuarios: `src/views/usuarios.ejs`.
- Comportamiento del buscador: `public/js/app.js`.
- Estilos del buscador: `public/css/styles.css`.
