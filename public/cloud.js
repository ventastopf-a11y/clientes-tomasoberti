// Capa de datos de la Cartera Mayorista sobre Supabase.
// La app se escribió para el runtime de claude.ai (window.claude.use('db' | 'assets' | 'sample')).
// Este archivo da la misma interfaz usando Supabase: login, tablas con tiempo real y archivos en Storage.
(() => {
  'use strict';
  const CFG = window.CARTERA_CONFIG || {};
  if (!CFG.url || !CFG.anonKey || !window.supabase) {
    window.claude = { use: async () => null };
    return;
  }
  const sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const BUCKET = 'comprobantes';
  const PAGE = 1000;

  // ---------- colecciones y tablas ----------
  // movimientos tiene columnas propias (para poder consultarlos con SQL);
  // el resto guarda el documento entero en la columna `data` (jsonb).
  const MOV = ['f', 'cid', 'tipo', 'monto', 'comp', 'medio', 'obs', 'creado'];
  const asJson = table => ({
    table,
    toRow: (id, d) => ({ id, data: d, updated_at: new Date().toISOString() }),
    fromRow: r => r.data || {},
  });
  const TABLES = {
    clientes: asJson('clientes'),
    ingresos: asJson('ingresos'),
    config: asJson('config'),
    movimientos: {
      table: 'movimientos',
      toRow: (id, d) => {
        const r = { id, updated_at: new Date().toISOString() };
        for (const k of MOV) r[k] = d[k] ?? (k === 'monto' ? 0 : '');
        r.monto = Number(r.monto) || 0;
        return r;
      },
      fromRow: r => {
        const o = {};
        for (const k of MOV) o[k] = r[k] ?? '';
        o.monto = Number(r.monto) || 0;
        return o;
      },
    },
  };

  const cache = {};      // colección -> Map(id -> documento)
  const loaded = {};     // colección -> Promise de la carga inicial
  const subs = {};       // colección -> Set de funciones que escuchan
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (a, b) => {
    const out = isObj(a) ? { ...a } : {};
    for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
    return out;
  };
  const err = e => {
    const msg = (e && (e.message || e.error_description)) || String(e);
    const code = e && (e.code === '42501' || /row-level security|permission|JWT/i.test(msg)) ? 'invalid_argument'
      : /fetch|network|Failed to/i.test(msg) ? 'unavailable' : 'unknown';
    return Object.assign(new Error(msg), { code });
  };

  function emit(col) {
    const docs = [...(cache[col] || new Map()).entries()].map(([id, d]) => ({ id, data: () => clone(d) }));
    const snap = { metadata: { fromCache: false }, docs, size: docs.length, empty: !docs.length };
    for (const fn of subs[col] || []) { try { fn(snap); } catch (e) { console.error(e); } }
  }

  function load(col) {
    if (loaded[col]) return loaded[col];
    const T = TABLES[col];
    if (!T) throw new Error('Colección desconocida: ' + col);
    cache[col] = new Map();
    loaded[col] = (async () => {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.from(T.table).select('*').order('id').range(from, from + PAGE - 1);
        if (error) throw err(error);
        for (const r of data) cache[col].set(r.id, T.fromRow(r));
        if (data.length < PAGE) break;
      }
      sb.channel('rt-' + col)
        .on('postgres_changes', { event: '*', schema: 'public', table: T.table }, p => {
          if (p.eventType === 'DELETE') cache[col].delete(p.old.id);
          else cache[col].set(p.new.id, T.fromRow(p.new));
          emit(col);
        })
        .subscribe();
    })();
    loaded[col].catch(() => { delete loaded[col]; });
    return loaded[col];
  }

  async function put(col, id, data) {
    const T = TABLES[col];
    const { data: rows, error } = await sb.from(T.table).upsert(T.toRow(id, data)).select('id');
    if (error) throw err(error);
    // si la base no devuelve la fila, el cambio no quedó guardado (permisos): se avisa en vez de mostrarlo como guardado
    if (!rows || !rows.length) throw Object.assign(new Error('la base no confirmó el cambio (revisá permisos y permitidos)'), { code: 'invalid_argument' });
    cache[col].set(id, clone(data));
    emit(col);
  }

  function docRef(col, id) {
    return {
      id,
      async set(data) { await load(col); await put(col, id, data); },
      async update(patch) {
        await load(col);
        const cur = cache[col].get(id);
        if (!cur) throw Object.assign(new Error('No existe ' + col + '/' + id), { code: 'not_found' });
        await put(col, id, merge(cur, patch));
      },
      async delete() {
        await load(col);
        const { error } = await sb.from(TABLES[col].table).delete().eq('id', id);
        if (error) throw err(error);
        cache[col].delete(id);
        emit(col);
      },
      async get() {
        await load(col);
        const d = cache[col].get(id);
        return { id, exists: !!d, data: () => clone(d) };
      },
      onSnapshot(fn, onErr) {
        const relay = () => { const d = cache[col].get(id); fn({ id, exists: !!d, data: () => clone(d) }); };
        (subs[col] = subs[col] || new Set()).add(relay);
        load(col).then(relay, e => onErr && onErr(err(e)));
        return () => subs[col].delete(relay);
      },
    };
  }

  const db = {
    collection: col => ({
      doc: id => docRef(col, id),
      onSnapshot(fn, onErr) {
        (subs[col] = subs[col] || new Set()).add(fn);
        load(col).then(() => emit(col), e => onErr && onErr(err(e)));
        return () => subs[col].delete(fn);
      },
    }),
    doc: path => { const [col, id] = String(path).split('/'); return docRef(col, id); },
  };

  // ---------- archivos (comprobantes) en Supabase Storage ----------
  const assets = {
    async upload(blob) {
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, '');
      const contentType = blob.type || 'application/octet-stream';
      const { error } = await sb.storage.from(BUCKET).upload(id, blob, { contentType, upsert: false });
      if (error) throw err(error);
      return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType };
    },
  };
  // La app enlaza los comprobantes como /_blob/<id>: se abren con un link firmado de Storage (vale 5 minutos).
  document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[href^="/_blob/"]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const id = decodeURIComponent(a.getAttribute('href').slice('/_blob/'.length));
    const w = window.open('', '_blank');
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(id, 300);
    if (error || !data) { if (w) w.close(); alert('No se pudo abrir el comprobante.'); return; }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
  }, true);

  // ---------- ingreso con usuario y contraseña ----------
  function loginScreen(msg) {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.id = 'login';
      box.innerHTML = `<form style="max-width:340px;margin:12vh auto 0;padding:24px;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:10px;display:grid;gap:12px;font:14px system-ui,sans-serif">
        <h2 style="margin:0;font-size:20px">Cartera Mayorista</h2>
        <p style="margin:0;color:var(--muted,#666)">Tomás Oberti Supplies · Ingresá con tu usuario</p>
        <label style="display:grid;gap:4px">Email<input name="email" type="email" autocomplete="username" required style="padding:9px;border:1px solid var(--line,#ccc);border-radius:6px;font:inherit"></label>
        <label style="display:grid;gap:4px">Contraseña<input name="pass" type="password" autocomplete="current-password" required style="padding:9px;border:1px solid var(--line,#ccc);border-radius:6px;font:inherit"></label>
        <button style="padding:10px;border:0;border-radius:6px;background:var(--accent,#0b6b70);color:#fff;font:inherit;font-weight:600;cursor:pointer">Ingresar</button>
        <p class="lg-msg" style="margin:0;color:var(--bad,#b3261e);min-height:1em">${msg || ''}</p></form>`;
      Object.assign(box.style, { position: 'fixed', inset: '0', zIndex: '100', background: 'var(--bg,#f3f5f7)', overflow: 'auto', padding: '0 16px' });
      document.body.appendChild(box);
      const form = box.querySelector('form');
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const btn = form.querySelector('button'); btn.disabled = true;
        const { error } = await sb.auth.signInWithPassword({ email: form.email.value.trim(), password: form.pass.value });
        btn.disabled = false;
        if (error) { form.querySelector('.lg-msg').textContent = 'Email o contraseña incorrectos.'; return; }
        box.remove();
        resolve();
      });
    });
  }
  function logoutButton() {
    const bar = document.querySelector('.top-actions');
    if (!bar || document.getElementById('btn-salir')) return;
    const b = document.createElement('button');
    b.id = 'btn-salir'; b.className = 'btn ghost'; b.textContent = 'Salir';
    b.addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
    bar.appendChild(b);
  }
  // Aviso visible cuando algo de la base no está bien configurado (en vez de mostrar la app vacía sin explicación).
  function aviso(txt) {
    let el = document.getElementById('aviso-base');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aviso-base';
      Object.assign(el.style, { position: 'fixed', left: '12px', right: '12px', bottom: '12px', zIndex: '90', padding: '12px 14px', borderRadius: '8px', background: 'var(--bad-soft,#fbe6e3)', color: 'var(--bad,#b3261e)', font: '14px system-ui,sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.15)', whiteSpace: 'pre-wrap' });
      document.body.appendChild(el);
    }
    el.textContent = txt;
  }
  async function revisarAcceso() {
    const { data: u } = await sb.auth.getUser();
    const email = (u && u.user && u.user.email) || '';
    const { data: ok, error } = await sb.rpc('es_permitido');
    if (error) {
      aviso(`No se pudo verificar el acceso (${error.message}).\nEn Supabase → SQL Editor corré los permisos "grant" de supabase/schema.sql.`);
      return;
    }
    if (!ok) {
      aviso(`El usuario ${email} entró pero no está habilitado, por eso no ve datos.\nEn Supabase → SQL Editor corré:\ninsert into public.permitidos (email) values ('${email}');\ny recargá la página.`);
      return;
    }
    const { error: e2 } = await sb.from('clientes').select('id').limit(1);
    if (e2) aviso(`El usuario está habilitado pero la base rechaza la lectura (${e2.message}).\nEn Supabase → SQL Editor corré los permisos "grant" de supabase/schema.sql.`);
  }
  const ready = (async () => {
    if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    const { data } = await sb.auth.getSession();
    if (!data.session) await loginScreen();
    logoutButton();
    // permiso para cargar o modificar movimientos (si la función todavía no existe en la base, se permite)
    const pm = await sb.rpc('puede_movimientos');
    window.CARTERA_PERMISOS = { movimientos: pm.error ? true : !!pm.data };
    revisarAcceso().catch(e => aviso('No se pudo conectar con Supabase: ' + (e && e.message)));
  })();

  // ---------- la misma interfaz que en claude.ai ----------
  // 'sample' (leer fotos con Claude) no existe fuera de claude.ai: los PDF de Contabilium se leen igual, sin costo.
  window.claude = {
    use: async name => {
      await ready;
      if (name === 'db') return db;
      if (name === 'assets') return assets;
      return null;
    },
  };
})();
