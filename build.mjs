// Arma la carpeta dist/ para Vercel: copia public/ y escribe config.js con los datos públicos de Supabase.
// SUPABASE_URL y SUPABASE_ANON_KEY se cargan en Vercel → Settings → Environment Variables.
// La clave "anon" es pública por diseño: lo que protege los datos son las políticas de seguridad (supabase/schema.sql).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error('Faltan SUPABASE_URL y SUPABASE_ANON_KEY en las variables de entorno.');
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('public', 'dist', { recursive: true });
writeFileSync('dist/config.js', `window.CARTERA_CONFIG = ${JSON.stringify({ url, anonKey })};\n`);
console.log('dist/ listo');
