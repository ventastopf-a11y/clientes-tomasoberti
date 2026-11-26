# Cartera Mayorista · Tomás Oberti Supplies

App para llevar la cartera de clientes mayoristas: seguimientos, recuperación, ingresos de mercadería, compras con sus artículos, cuentas corrientes y movimientos.

- **Frontend:** una sola página (`public/index.html`), sin framework. Se publica en Vercel.
- **Datos:** Supabase (Postgres con tiempo real, login y Storage para los comprobantes). `public/cloud.js` conecta la app con Supabase.
- **Facturas y cotizaciones de Contabilium:** se leen en el navegador, sin costo (pdf.js).

Los datos de clientes **no** se guardan en este repositorio.

## Puesta en marcha

### 1. Supabase
1. Crear un proyecto en [supabase.com](https://supabase.com) (región São Paulo).
2. **SQL Editor → New query:** pegar y correr `supabase/schema.sql`.
3. **SQL Editor → New query:** pegar y correr el archivo de datos exportado (`seed-datos.sql`, no está en el repo).
4. **Authentication → Users → Add user:** crear el usuario de cada persona (email y contraseña, con "Auto Confirm User").
5. **SQL Editor:** habilitar a esas personas:
   ```sql
   insert into public.permitidos (email) values ('persona@ejemplo.com');
   ```
6. **Storage → comprobantes:** subir los comprobantes exportados (el nombre del archivo tiene que quedar igual).
7. **Project Settings → API:** copiar la *Project URL* y la clave *anon public*.

### 2. Vercel
1. **Add New → Project →** importar este repositorio.
2. **Environment Variables:** `SUPABASE_URL` y `SUPABASE_ANON_KEY` (los valores del paso 1.7).
3. **Deploy.** El build (`npm run build`) arma `dist/` con `config.js`.

## Seguridad
- La clave *anon* es pública por diseño. Los datos los protegen las políticas de `schema.sql`: solo los emails cargados en `permitidos` pueden leer y escribir.
- La clave *service_role* nunca va en el código ni en Vercel.
