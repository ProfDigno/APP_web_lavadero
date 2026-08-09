# App Web Lavadero

Aplicacion web local para gestionar lavados de autos con Node.js y PostgreSQL 9.5.

## Requisitos

- Node.js instalado.
- PostgreSQL escuchando en `localhost:5432`.
- Base de datos creada: `bdlavadero_a1`.

## Configuracion

Copie `.env.example` a `.env` si necesita cambiar puerto, usuario o clave de PostgreSQL.
Las reglas generales de formato estan en `CONFIGURACION_SISTEMA.md`.
Las reglas para nuevas pantallas CRUD estan en `CONFIGURACION_CRUD.md`.

Valores actuales esperados:

- Base: `bdlavadero_a1`
- Usuario: `postgres`
- Puerto: `5432`

## Primer uso

```bash
npm install
npm run setup-db
npm start
```

Abra `http://localhost:3010`.

Usuario inicial:

- Usuario: `admin`
- Clave: `admin123`

## Flujo recomendado

1. Cargar personal.
2. Cargar servicios.
3. Opcionalmente cargar grupos de cliente.
4. Registrar lavados desde la pantalla Lavados.
