# Configuracion del sistema

Este documento registra reglas generales que deben respetarse en toda la app Lavadero.

## Fechas y horas

Formato oficial de fecha y hora:

```text
DD-MM-YYYY HH:MM
```

Ejemplo:

```text
05-08-2026 14:30
```

Reglas:

- Fecha con dia y mes de dos digitos.
- Anio de cuatro digitos.
- Separador de fecha con guion.
- Hora en formato 24 horas.
- Minutos de dos digitos.
- Cuando se muestra solo fecha, usar `DD-MM-YYYY`.
- Cuando se muestra solo hora, usar `HH:MM`.

Implementacion actual:

- Las pantallas usan `formatDateTime`, `formatDate` y `formatTime` desde `src/server.js`.
- Los reportes PDF y Excel usan esas mismas funciones para mantener el formato uniforme.
