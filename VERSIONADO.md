# Versionado de la aplicación

La versión visible en la pantalla de ingreso se obtiene de `package.json` y se muestra automáticamente como `Versión X.Y.Z`.

## Regla de actualización

Cada modificación publicada debe incrementar la versión antes de crear el commit:

- `PATCH` (`1.0.1`): correcciones y cambios pequeños sin alterar la funcionalidad principal.
- `MINOR` (`1.1.0`): nuevas funcionalidades compatibles con el comportamiento existente.
- `MAJOR` (`2.0.0`): cambios incompatibles o rediseños importantes.

La versión debe mantenerse igual en `package.json` y `package-lock.json`.

## Procedimiento

1. Incrementar la versión según el tipo de cambio.
2. Verificar que el login muestre la nueva versión.
3. Ejecutar las validaciones del proyecto.
4. Incluir el cambio de versión en el mismo commit que la modificación.
5. Publicar y verificar la versión en el servidor.

Versión actual: **1.0.2**.
