# Configuracion de diseno del formulario cliente

Este documento registra la configuracion visual y de comportamiento del formulario de clientes de la app Lavadero.

## Ubicacion

- Vista principal: `src/views/crud.ejs`
- Estilos: `public/css/styles.css`
- Comportamiento de apertura y cierre: `public/js/app.js`
- Definicion de campos: `src/server.js`

## Pantalla de clientes

La pantalla de clientes usa el layout CRUD general, pero con una variante propia:

- La seccion principal usa `grid one`, por lo que la tabla ocupa una sola columna.
- El formulario de alta y edicion no queda fijo al lado de la tabla.
- El boton superior `Nuevo cliente` abre el formulario dentro de un modal.
- La tabla de clientes muestra acciones compactas: editar con icono y activar/desactivar con switch.

## Modal del formulario

El formulario de clientes se muestra dentro de un modal:

- Fondo: overlay fijo sobre toda la pantalla.
- Overlay: `rgba(23, 32, 42, .55)`.
- Z-index: `10`.
- Alineacion: centrado vertical y horizontal con grid.
- Separacion contra bordes de pantalla: `18px`.
- Panel: fondo blanco.
- Ancho del panel: `min(680px, 100%)`.
- Alto maximo: `calc(100vh - 36px)`.
- Scroll interno: `overflow-y: auto`.
- Padding interno: `18px`.
- Radio de borde: `8px`.
- Sombra: `0 18px 48px rgba(0, 0, 0, .24)`.

El modal se oculta con la clase `is-hidden`.

## Campos del formulario

Los campos configurados para cliente son:

| Campo | Etiqueta | Tipo | Requerido | Transformacion |
| --- | --- | --- | --- | --- |
| `chapa` | Chapa | Texto | Si | Mayusculas |
| `marca_modelo` | Marca/modelo | Texto | Si | Mayusculas |
| `ruc` | RUC | Texto | No | Mayusculas |
| `nombre` | Nombre | Texto | No | Mayusculas |
| `direccion` | Direccion | Texto | No | Mayusculas |
| `telefono` | Telefono | Texto | No | Mayusculas |
| `grupo_cliente_id` | Grupo cliente | Select | No | Seleccion de grupo |
| `activo` | Activo | Checkbox | No | Activo por defecto |

## Estilo de etiquetas e inputs

Las etiquetas usan:

- Display: `grid`.
- Separacion interna entre texto y campo: `6px`.
- Color: `var(--muted)`.
- Peso tipografico: `700`.

Los inputs y selects usan:

- Ancho: `100%`.
- Alto minimo: `42px`.
- Padding: `9px 10px`.
- Borde: `1px solid var(--line)`.
- Radio de borde: `6px`.
- Fondo: blanco.
- Color: `var(--text)`.
- Tipografia: heredada de la app.

## Checkbox activo

El campo `activo` usa la clase `check`:

- Layout: flex horizontal.
- Alineacion: centrada.
- Separacion: `8px`.
- Checkbox: ancho `18px` y alto minimo `18px`.
- En alta de cliente aparece marcado por defecto.

## Botones del modal

Las acciones del modal usan la clase `modal-actions`:

- Display: flex.
- Separacion entre botones: `10px`.

Boton principal:

- Alto minimo: `42px`.
- Padding horizontal: `16px`.
- Radio: `6px`.
- Fondo: `var(--primary)`.
- Texto: blanco.
- Peso: `700`.

Boton secundario:

- Fondo: `#e8f3f1`.
- Texto: `var(--primary-dark)`.

## Comportamiento

Al presionar `Nuevo cliente`:

- Se actualiza el titulo a `Nuevo cliente`.
- Se limpia el formulario.
- Los checkboxes se marcan por defecto.
- Se abre el modal.
- El foco pasa al primer input o select disponible.

Al editar:

- La URL incluye `?edit=<id>`.
- El modal abre con el titulo `Editar cliente`.
- Los campos se completan con los datos existentes.
- El submit guarda cambios sobre `/clientes/<id>`.

El modal se cierra:

- Con el boton `Cancelar`.
- Al hacer click fuera del panel.
- Con la tecla `Escape`.
- Si estaba editando, al cerrar vuelve a la ruta `/clientes`.

## Tabla asociada

En la tabla de clientes:

- Filas inactivas usan fondo `#fff1ef`.
- Texto de filas inactivas usa `var(--danger)`.
- Celdas de filas inactivas se muestran tachadas, excepto la columna de acciones.
- El boton editar usa `icon-button`, con tamano `34px` por `34px`.
- El estado activo/inactivo se maneja con un switch visual `toggle-check`.

## Variables visuales usadas

Las principales variables de color del formulario son:

| Variable | Valor | Uso |
| --- | --- | --- |
| `--bg` | `#f6f7f9` | Fondo general |
| `--surface` | `#ffffff` | Superficies y paneles |
| `--text` | `#17202a` | Texto principal |
| `--muted` | `#687385` | Etiquetas y textos secundarios |
| `--line` | `#dce1e8` | Bordes |
| `--primary` | `#0f766e` | Boton principal |
| `--primary-dark` | `#115e59` | Texto/enlaces principales |
| `--danger` | `#b42318` | Estados inactivos o peligro |
| `--ok` | `#137333` | Estado activo |

## Responsive

Para pantallas de hasta `760px`:

- El contenedor general reduce padding a `14px`.
- Los encabezados y acciones se acomodan en columna cuando corresponde.
- La tabla conserva scroll horizontal desde `.table-wrap`.
- El modal mantiene ancho `100%` hasta el limite disponible.

## Reglas a conservar

- Mantener el formulario de clientes como modal, no como panel lateral.
- Mantener `chapa` y `marca_modelo` como campos requeridos.
- Mantener conversion automatica a mayusculas en los campos principales del cliente.
- Mantener el checkbox `activo` marcado por defecto para nuevos clientes.
- Mantener acciones compactas en la tabla: icono para editar y switch para activar/desactivar.
