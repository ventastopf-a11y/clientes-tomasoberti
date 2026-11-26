// Arma la carpeta dist/ para Vercel: copia public/ y escribe config.js con los datos públicos de Supabase.
// SUPABASE_URL y SUPABASE_ANON_KEY se cargan en Vercel → Settings → Environment Variables.
// La clave "anon" es pública por diseño: lo que protege los datos son las políticas de seguridad (supabase/schema.sql).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

// También acepta los nombres que carga la integración Supabase ↔ Vercel.
const pick = (...names) => names.map(n => process.env[n]).find(Boolean);
const url = pick('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL');
const anonKey = pick('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
if (!url || !anonKey) {
  console.error('Faltan las variables de entorno de Supabase en Vercel:');
  console.error(`  SUPABASE_URL: ${url ? 'ok' : 'falta'} · SUPABASE_ANON_KEY: ${anonKey ? 'ok' : 'falta'}`);
  console.error('Cargalas en Vercel → Settings → Environment Variables (marcando Production) y volvé a hacer Redeploy.');
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('public', 'dist', { recursive: true });
writeFileSync('dist/config.js', `window.CARTERA_CONFIG = ${JSON.stringify({ url, anonKey })};\n`);
console.log('dist/ listo');
