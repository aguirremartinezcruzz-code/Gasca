/* Gasca · entregas certificadas. App web con Firebase (cuentas + Firestore). */
import { FIREBASE_CONFIG, OWNER_EMAIL } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail, reload
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
  orderBy, limit, onSnapshot, runTransaction, increment
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pesos = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
const cents = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s) => String(s || '').trim().toLowerCase();
const folio = (id) => '#' + String(id).slice(-4).toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = { abierto: 'Buscando moto', asignado: 'Asignado', recogido: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado' };
const FRESH_MS = 150000; // una persona cuenta como conectada si avisó hace menos de 2.5 min
const COM_C = 5; // la comisión es el 5%: 5 centavos por cada peso del envío

const OWNER = String(OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_OK = OWNER.indexOf('@') > 0;
const comC = (o) => (Number(o.tarifa) || 0) * COM_C; // comisión en centavos

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = 'es';
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

/* ---------- estado ---------- */
const S = {
  ready: false, user: null, uid: null, email: '', ownerEmail: false, isAdmin: false, creating: false,
  authMode: 'login', authBusy: false, authErr: '',
  profile: null, profileReady: false, role: null, name: '', addr: '',
  myAprob: null, aprReady: false, fotos: {}, consent: false, verEdit: false, uploading: {},
  roleOn: false, perm: false, dbErr: false,
  tab: '', orders: [], openOrders: [], myOrders: [], known: new Set(), openReady: false, prev: new Map(),
  wallet: null, walletReady: false, movs: [], recargas: [], pago: '', pagoDirty: false,
  users: [], aprobs: {}, wallets: {}, presence: {},
  review: null, revPhotos: null, suspId: null, motivo: '',
  online: false, queue: [], ignored: new Set(), sheetId: null, sheetTaken: null, sheetT: null, sheetKey: '',
  rechargeOpen: false, cancelId: null, busy: new Set(), ac: null, wake: null
};

let unsubs = [];
let roleUnsubs = [];
function listen(list, ref, next) {
  list.push(onSnapshot(ref, (s) => { S.perm = false; next(s); }, onListenErr));
}
function onListenErr(e) {
  if (e && e.code === 'permission-denied') S.perm = true; else S.dbErr = true;
  render();
}
function stopRole() { roleUnsubs.forEach((f) => { try { f(); } catch (e) {} }); roleUnsubs = []; S.roleOn = false; }
function stopAll() { unsubs.forEach((f) => { try { f(); } catch (e) {} }); unsubs = []; stopRole(); }

function resetData() {
  Object.assign(S, {
    profile: null, profileReady: false, role: null, name: '', addr: '', myAprob: null, aprReady: false, fotos: {},
    consent: false, verEdit: false, uploading: {}, perm: false, dbErr: false, tab: '',
    orders: [], openOrders: [], myOrders: [], known: new Set(), openReady: false, prev: new Map(),
    wallet: null, walletReady: false, movs: [], recargas: [], pago: '', pagoDirty: false,
    users: [], aprobs: {}, wallets: {}, presence: {}, review: null, revPhotos: null, suspId: null, motivo: '',
    online: false, queue: [], ignored: new Set(), sheetId: null, sheetTaken: null, sheetKey: '',
    rechargeOpen: false, cancelId: null, busy: new Set()
  });
  clearTimeout(S.sheetT);
  releaseWake();
  clearDom();
}
/* Al cambiar de cuenta en el mismo teléfono no debe quedar nada de la cuenta anterior. */
function clearDom() {
  ['#viewVerify', '#shopList', '#riderHead', '#riderAvail', '#riderTrips', '#walletTop', '#walletList', '#adminMonitor', '#adminAltas', '#adminRecargas', '#adminSaldos', '#sheet']
    .forEach((s) => { const el = $(s); if (el) el.innerHTML = ''; });
  ['#o-pick', '#o-cliente', '#o-tel', '#o-dest', '#o-desc', '#o-cobro', '#o-tarifa', '#r-monto', '#a-pago', '#a-buscar']
    .forEach((s) => { const el = $(s); if (el) el.value = ''; });
}

/* ---------- sonido, vibración y avisos ---------- */
function ensureAudio() {
  try {
    if (!S.ac) S.ac = new (window.AudioContext || window.webkitAudioContext)();
    if (S.ac.state === 'suspended') S.ac.resume();
  } catch (e) {}
}
function beep(freqs) {
  try {
    if (!S.ac) return;
    let t = S.ac.currentTime;
    (freqs || [880, 1175, 880]).forEach((f) => {
      const o = S.ac.createOscillator(), g = S.ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(S.ac.destination);
      o.start(t); o.stop(t + 0.24); t += 0.26;
    });
  } catch (e) {}
}
function buzz() { try { if (navigator.vibrate) navigator.vibrate([220, 110, 220]); } catch (e) {} }
let toastT;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3400);
}
/* Mantiene la pantalla encendida mientras el repartidor está en línea. */
async function holdWake() {
  try { if (navigator.wakeLock && !S.wake && document.visibilityState === 'visible') { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch (e) {}
}
function releaseWake() { try { if (S.wake) S.wake.release(); } catch (e) {} S.wake = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (S.online) holdWake(); pushPresence(); }
});

/* ---------- utilidades ---------- */
const byId = (id) => S.orders.find((o) => o.id === id);
function ago(t) {
  if (!t) return '';
  const s = Math.max(0, ((Date.now() - t) / 1000) | 0);
  if (s < 45) return 'ahora';
  const m = Math.round(s / 60); if (m < 60) return 'hace ' + m + ' min';
  const h = Math.round(m / 60); if (h < 24) return 'hace ' + h + ' h';
  return new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
const isToday = (t) => new Date(t).toDateString() === new Date().toDateString();
const mine = () => S.orders.filter((o) => o.driverId === S.uid);
const mapsUrl = (a) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a);
function waUrl(tel) {
  let d = String(tel || '').replace(/\D/g, ''); if (!d) return '';
  if (d.length === 10) d = '52' + d;
  return 'https://wa.me/' + d;
}
const canAct = () => !!S.uid && !S.dbErr;
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0, O, 1, I, L
function newCode() {
  const used = new Set(S.recargas.map((r) => r.codigo));
  for (let t = 0; t < 20; t++) {
    const n = new Uint32Array(8); let s = '';
    try { crypto.getRandomValues(n); } catch (e) { for (let k = 0; k < 8; k++) n[k] = Math.floor(Math.random() * 4294967296); }
    for (let i = 0; i < 8; i++) s += ALPHA[n[i] % ALPHA.length];
    const c = 'RC-' + s.slice(0, 4) + '-' + s.slice(4);
    if (!used.has(c)) return c;
  }
  return 'RC-' + Date.now().toString(36).toUpperCase();
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const saldoC = () => (S.wallet && Number(S.wallet.saldoC)) || 0;
const canTake = (o) => S.walletReady && !!S.wallet && saldoC() >= comC(o);

/* ---------- verificación de documentos ---------- */
const VER = {
  rider: [
    { k: 'ine', t: 'INE', h: 'Foto de tu INE por el frente. Que se vean tu foto y tus datos completos.' },
    { k: 'licencia', t: 'Licencia de conducir', h: 'Por el frente, vigente y legible.' },
    { k: 'moto', t: 'Foto de la moto completa', h: 'Toda la moto de lado, de la llanta de adelante a la de atrás.' },
    { k: 'placa', t: 'Moto completa con la placa', h: 'Toda la moto vista por detrás, con la placa legible.' }
  ],
  shop: [
    { k: 'ine', t: 'INE del dueño o encargado', h: 'Foto de la INE por el frente. Que se vean la foto y los datos completos.' },
    { k: 'domicilio', t: 'Comprobante de domicilio', h: 'Recibo de luz, agua, teléfono o estado de cuenta reciente. Que se vea completo.' },
    { k: 'local', t: 'Foto del local', h: 'El frente de tu negocio. Si vendes desde tu casa, una foto de la casa.' }
  ]
};
const ROLE_LBL = { rider: 'Repartidor', shop: 'Tienda o restaurante' };
function safeImg(s) { return typeof s === 'string' && s.length < 260000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(s) ? s : ''; }
function personStatus(u, a) {
  const docsEn = (u && u.docsEn) || 0;
  if (a && a.estado === 'aprobado') return 'aprobado';
  if (a && a.estado === 'rechazado' && (a.en || 0) >= docsEn) return 'rechazado';
  return docsEn ? 'revision' : 'incompleto';
}
const verLabel = (st) => ({ revision: 'Documentos por revisar', incompleto: 'Sin documentos', rechazado: 'Documentos rechazados', aprobado: 'Aprobado' }[st] || '');
function myStatus() {
  if (!S.profileReady || !S.aprReady) return 'cargando';
  if (!S.profile) return 'perfil';
  return personStatus(S.profile, S.myAprob);
}
function view() {
  if (!S.ready || S.creating) return 'loading';
  if (!S.user) return 'auth';
  if (S.ownerEmail && !S.isAdmin) return 'owner';
  if (S.isAdmin) return 'admin';
  const st = myStatus();
  if (st === 'cargando') return 'loading';
  if (st === 'perfil') return 'profile';
  if (st !== 'aprobado') return 'verify';
  return S.role === 'shop' ? 'shop' : 'rider';
}

/* ---------- entrar y crear cuenta ---------- */
const af = $('#authForm');
const roleVal = () => (af.elements.role && af.elements.role.value) || '';
function setMode(m) {
  S.authMode = m; S.authErr = '';
  const su = m === 'signup', ow = m === 'owner', pr = m === 'profile', form = su || pr;
  $('#authTitle').textContent = { login: 'Entrar', signup: 'Crear cuenta', owner: 'Dueño', profile: 'Completa tu cuenta' }[m];
  $('#authLede').textContent = {
    login: 'Entra con tu correo y tu contraseña.',
    signup: 'Crea tu cuenta una sola vez. Después entras con tu correo y tu contraseña.',
    owner: 'Solo para el dueño de Gasca.',
    profile: 'Elige quién eres para terminar de crear tu cuenta.'
  }[m];
  $('#authRoles').hidden = !form;
  $('#fName').hidden = !form;
  $('#fAddr').hidden = !(form && roleVal() === 'shop');
  $('#fEmail').hidden = pr; $('#fPass').hidden = pr;
  $('#authHint').hidden = !form;
  $('#lblName').textContent = roleVal() === 'shop' ? 'Nombre del negocio' : 'Tu nombre';
  $('#a-name').placeholder = roleVal() === 'shop' ? 'Ej. Pizzería La Esquina' : 'Ej. Juan Pérez';
  $('#a-pass').autocomplete = su ? 'new-password' : 'current-password';
  $('#authBtn').textContent = { login: 'Entrar', signup: 'Crear cuenta', owner: 'Entrar', profile: 'Guardar' }[m];
  $('#authBtn2').hidden = !ow;
  const link = (act, txt) => '<button type="button" data-act="' + act + '">' + txt + '</button>';
  $('#authLinks').innerHTML = {
    login: link('mode-signup', 'Crear cuenta') + link('reset', 'Olvidé mi contraseña') + link('mode-owner', 'Soy el dueño'),
    signup: link('mode-login', 'Ya tengo cuenta'),
    owner: link('mode-login', 'Volver') + link('reset', 'Olvidé mi contraseña'),
    profile: link('signout', 'Salir')
  }[m];
  showErr();
}
function showErr() { const el = $('#authErr'); el.hidden = !S.authErr; el.textContent = S.authErr; }
function authMsg(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/email-already-in-use') return 'Ese correo ya tiene cuenta. Toca "Ya tengo cuenta".';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found' || c === 'auth/invalid-login-credentials') return 'Correo o contraseña incorrectos.';
  if (c === 'auth/weak-password') return 'La contraseña debe tener al menos 6 caracteres.';
  if (c === 'auth/invalid-email') return 'Ese correo no se ve bien. Revísalo.';
  if (c === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e intenta de nuevo.';
  if (c === 'auth/network-request-failed') return 'No hay internet. Revisa tu conexión.';
  if (c === 'permission-denied') return 'No se pudo guardar tu cuenta. Avisa a la administración.';
  return 'No se pudo completar. Intenta de nuevo.';
}
async function createProfile(uid, p) {
  const rec = { id: uid, role: p.role, name: p.name, creadoEn: Date.now() };
  if (p.role === 'shop') rec.addr = p.addr;
  await setDoc(doc(db, 'users', uid), rec);
}
function setBusy(b) { S.authBusy = b; $('#authBtn').disabled = b; $('#authBtn2').disabled = b; }

af.addEventListener('change', (e) => { if (e.target && e.target.name === 'role') { const m = S.authMode; const keep = S.authErr; setMode(m); S.authErr = keep; showErr(); } });
af.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (S.authBusy) return;
  const m = S.authMode;
  const email = $('#a-email').value.trim().toLowerCase(), pass = $('#a-pass').value;
  const role = roleVal(), name = $('#a-name').value.trim(), addr = $('#a-addr').value.trim();
  const fail = (msg) => { S.authErr = msg; showErr(); };
  S.authErr = ''; showErr();
  const needProfile = () => {
    if (!role) return 'Elige si eres tienda o repartidor.';
    if (name.length < 2) return 'Escribe tu nombre.';
    if (role === 'shop' && addr.length < 5) return 'Escribe la dirección de tu negocio.';
    return '';
  };
  try {
    if (m === 'login' || m === 'owner') {
      if (!email || !pass) return fail('Escribe tu correo y tu contraseña.');
      if (m === 'owner' && (!OWNER_OK || email !== OWNER)) return fail('Ese correo no es el del dueño.');
      setBusy(true);
      await signInWithEmailAndPassword(auth, email, pass);
    } else if (m === 'signup') {
      const pe = needProfile(); if (pe) return fail(pe);
      if (!email) return fail('Escribe tu correo.');
      if (pass.length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
      if (OWNER_OK && email === OWNER) return fail('Ese correo es del dueño. Usa "Soy el dueño".');
      setBusy(true); S.creating = true; render();
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await createProfile(cred.user.uid, { role, name, addr });
    } else if (m === 'profile') {
      const pe = needProfile(); if (pe) return fail(pe);
      setBusy(true);
      await createProfile(S.uid, { role, name, addr });
    }
  } catch (err) { fail(authMsg(err)); }
  S.creating = false; setBusy(false); render();
});

async function ownerCreate() {
  if (S.authBusy) return;
  const email = $('#a-email').value.trim().toLowerCase(), pass = $('#a-pass').value;
  if (!OWNER_OK || email !== OWNER) { S.authErr = 'Ese correo no es el del dueño.'; showErr(); return; }
  if (pass.length < 6) { S.authErr = 'La contraseña debe tener al menos 6 caracteres.'; showErr(); return; }
  S.authErr = ''; showErr(); setBusy(true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    try { await sendEmailVerification(cred.user); } catch (e) {}
  } catch (err) { S.authErr = authMsg(err); showErr(); }
  setBusy(false);
}
async function ownerCheck() {
  const u = auth.currentUser; if (!u) return;
  try { await reload(u); await u.getIdToken(true); } catch (e) { toast('No se pudo revisar. Intenta de nuevo.'); return; }
  bootstrap(auth.currentUser);
  if (!S.isAdmin) toast('Todavía no aparece verificado. Toca el enlace del correo y vuelve a intentar.');
}
async function ownerResend() {
  try { await sendEmailVerification(auth.currentUser); toast('Te enviamos el correo otra vez.'); } catch (e) { toast('Espera un momento antes de pedirlo de nuevo.'); }
}
async function resetPass() {
  const email = $('#a-email').value.trim().toLowerCase();
  if (!email) { S.authErr = 'Escribe tu correo arriba y vuelve a tocar "Olvidé mi contraseña".'; showErr(); return; }
  try { await sendPasswordResetEmail(auth, email); S.authErr = ''; showErr(); toast('Si ese correo tiene cuenta, te enviamos un enlace para cambiar la contraseña.'); }
  catch (err) { S.authErr = authMsg(err); showErr(); }
}
async function doSignOut() {
  stopAll(); resetData();
  try { await signOut(auth); } catch (e) {}
  $('#a-pass').value = '';
}

/* ---------- arranque de sesión ---------- */
function bootstrap(u) {
  stopAll(); resetData();
  S.user = u || null; S.ready = true;
  if (!u) { S.uid = null; S.email = ''; S.ownerEmail = false; S.isAdmin = false; $('#a-pass').value = ''; setMode('login'); render(); return; }
  S.uid = u.uid; S.email = (u.email || '').toLowerCase();
  S.ownerEmail = OWNER_OK && S.email === OWNER;
  S.isAdmin = S.ownerEmail && u.emailVerified === true;
  if (S.ownerEmail && !S.isAdmin) { render(); return; }
  if (S.isAdmin) { S.tab = 'monitor'; startAdmin(); render(); return; }
  startPerson();
  render();
}
onAuthStateChanged(auth, (u) => bootstrap(u));

function startPerson() {
  listen(unsubs, doc(db, 'users', S.uid), (s) => {
    S.profile = s.exists() ? s.data() : null; S.profileReady = true;
    if (S.profile) { S.role = S.profile.role; S.name = S.profile.name || ''; S.addr = S.profile.addr || ''; if (!S.tab) S.tab = S.role === 'rider' ? 'disp' : 'nuevo'; }
    syncRole(); render();
  });
  listen(unsubs, doc(db, 'aprobaciones', S.uid), (s) => {
    const was = S.aprReady ? myStatus() : '';
    S.myAprob = s.exists() ? s.data() : null; S.aprReady = true;
    if (was && was !== 'aprobado' && was !== 'cargando' && myStatus() === 'aprobado') { beep([660, 990]); toast('Tu cuenta fue aprobada. Ya puedes entrar.'); }
    syncRole(); render();
  });
  listen(unsubs, collection(db, 'docs', S.uid, 'fotos'), (snap) => {
    const m = {};
    snap.docs.forEach((d) => { const x = d.data(); if (x && safeImg(x.img)) m[d.id] = x.img; });
    S.fotos = m; render();
  });
  pushPresence();
}
function syncRole() {
  const ok = myStatus() === 'aprobado';
  if (ok && !S.roleOn) startRole();
  else if (!ok && S.roleOn) { stopRole(); S.orders = []; S.openOrders = []; S.myOrders = []; S.wallet = null; S.walletReady = false; S.online = false; releaseWake(); }
}

function mergeOrders() {
  if (S.role === 'rider') {
    const m = new Map();
    S.openOrders.forEach((o) => m.set(o.id, o));
    S.myOrders.forEach((o) => m.set(o.id, o));
    S.orders = Array.from(m.values());
  } else { S.orders = S.myOrders; }
  S.orders.sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));
}
const orderDocs = (snap) => snap.docs.map((d) => d.data()).filter((o) => o && o.estado && o.id);

function startRole() {
  S.roleOn = true;
  if (S.role === 'rider') {
    ensureWallet();
    listen(roleUnsubs, query(collection(db, 'orders'), where('estado', '==', 'abierto')), onOpenOrders);
    listen(roleUnsubs, query(collection(db, 'orders'), where('driverId', '==', S.uid)), (snap) => { S.myOrders = orderDocs(snap); mergeOrders(); syncSheet(); render(); });
    listen(roleUnsubs, doc(db, 'wallets', S.uid), (s) => { S.wallet = s.exists() ? s.data() : null; S.walletReady = true; if (S.online) queueOpen(); syncSheet(); render(); });
    listen(roleUnsubs, query(collection(db, 'movs'), where('driverId', '==', S.uid)), (snap) => { S.movs = snap.docs.map((d) => d.data()); render(); });
    listen(roleUnsubs, query(collection(db, 'recargas'), where('driverId', '==', S.uid)), (snap) => { S.recargas = snap.docs.map((d) => d.data()).filter((r) => r && r.id && r.estado); render(); });
    listen(roleUnsubs, doc(db, 'config', 'pago'), (s) => { S.pago = (s.exists() && s.data().texto) || ''; render(); });
  } else {
    listen(roleUnsubs, query(collection(db, 'orders'), where('shopId', '==', S.uid)), onShopOrders);
  }
}
async function ensureWallet() {
  try {
    const ref = doc(db, 'wallets', S.uid);
    const s = await getDoc(ref);
    if (!s.exists()) await setDoc(ref, { saldoC: 0 });
  } catch (e) {}
}

function onOpenOrders(snap) {
  const open = orderDocs(snap), fresh = [];
  open.forEach((o) => {
    if (!S.known.has(o.id)) { S.known.add(o.id); if (S.openReady && Date.now() - (o.creadoEn || 0) < 120000) fresh.push(o); }
  });
  S.openReady = true; S.openOrders = open; mergeOrders();
  if (S.online && fresh.length) {
    fresh.sort((a, b) => b.creadoEn - a.creadoEn);
    let pushed = 0;
    fresh.forEach((o) => { if (!S.ignored.has(o.id) && canTake(o) && S.queue.indexOf(o.id) < 0) { S.queue.unshift(o.id); pushed++; } });
    if (pushed) { beep(); buzz(); }
  }
  syncSheet(); render();
}
function onShopOrders(snap) {
  const orders = orderDocs(snap);
  orders.forEach((o) => {
    const before = S.prev.get(o.id);
    if (S.openReady && before === 'abierto' && o.estado === 'asignado') { beep([660, 990]); toast((o.driverName || 'Un repartidor') + ' tomó el pedido ' + folio(o.id) + '.'); }
    S.prev.set(o.id, o.estado);
  });
  S.openReady = true; S.myOrders = orders; mergeOrders(); render();
}
function queueOpen() {
  S.orders.filter((o) => o.estado === 'abierto' && !S.ignored.has(o.id) && canTake(o))
    .sort((a, b) => b.creadoEn - a.creadoEn)
    .forEach((o) => { if (S.queue.indexOf(o.id) < 0) S.queue.push(o.id); });
}

function startAdmin() {
  listen(unsubs, query(collection(db, 'orders'), orderBy('creadoEn', 'desc'), limit(200)), (snap) => { S.myOrders = orderDocs(snap); mergeOrders(); render(); });
  listen(unsubs, query(collection(db, 'users'), limit(500)), (snap) => { S.users = snap.docs.map((d) => d.data()).filter((u) => u && u.id && u.role && u.name); render(); });
  listen(unsubs, query(collection(db, 'aprobaciones'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.aprobs = m; render(); });
  listen(unsubs, query(collection(db, 'recargas'), orderBy('creadoEn', 'desc'), limit(300)), (snap) => { S.recargas = snap.docs.map((d) => d.data()).filter((r) => r && r.id && r.estado); render(); });
  listen(unsubs, query(collection(db, 'wallets'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.wallets = m; render(); });
  listen(unsubs, query(collection(db, 'movs'), orderBy('creadoEn', 'desc'), limit(1000)), (snap) => { S.movs = snap.docs.map((d) => d.data()); render(); });
  listen(unsubs, query(collection(db, 'presence'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.presence = m; render(); });
  listen(unsubs, doc(db, 'config', 'pago'), (s) => { S.pago = (s.exists() && s.data().texto) || ''; render(); });
}

/* Quién tiene la app abierta: cada teléfono avisa cada minuto. */
function pushPresence() {
  if (!S.uid || S.isAdmin || S.ownerEmail) return;
  setDoc(doc(db, 'presence', S.uid), { online: !!S.online, lastSeen: Date.now(), role: S.role || '', name: S.name || '' }).catch(() => {});
}
setInterval(() => { if (document.visibilityState === 'visible') pushPresence(); }, 60000);

/* ---------- acciones de pedidos ---------- */
async function createOrder(o) {
  const id = newId();
  await setDoc(doc(db, 'orders', id), Object.assign({ id, estado: 'abierto', driverId: '', driverName: '', creadoEn: Date.now() }, o));
  return id;
}

async function accept(id) {
  if (!canAct() || S.busy.has(id) || view() !== 'rider') return;
  const oo = byId(id);
  if (oo && !canTake(oo)) { toast('Tu saldo no alcanza. Recarga para aceptar pedidos.'); S.tab = 'saldo'; render(); return; }
  S.busy.add(id); renderSheet(true); render();
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'orders', id), s = await tx.get(ref);
      if (!s.exists() || s.data().estado !== 'abierto') throw new Error('taken');
      tx.update(ref, { estado: 'asignado', driverId: S.uid, driverName: S.name || 'Repartidor', asignadoEn: Date.now() });
    });
    beep([660, 990]);
    toast('Es tuyo. Ve por el pedido ' + folio(id) + '.');
    S.tab = 'viajes'; S.queue = S.queue.filter((x) => x !== id);
    if (S.sheetId === id) { S.sheetId = null; clearTimeout(S.sheetT); }
  } catch (e) {
    if (e && e.message === 'taken') toast('Otro repartidor lo tomó primero.');
    else if (e && e.code === 'permission-denied') toast('No se pudo aceptar. Revisa que tu saldo alcance y que tu cuenta esté aprobada.');
    else toast('No se pudo aceptar. Intenta de nuevo.');
  }
  S.busy.delete(id); syncSheet(); render();
}

async function picked(id) {
  const o = byId(id);
  if (!canAct() || !o || o.driverId !== S.uid || o.estado !== 'asignado' || S.busy.has(id)) return;
  S.busy.add(id); render();
  try { await updateDoc(doc(db, 'orders', id), { estado: 'recogido', recogidoEn: Date.now() }); toast('Marcado como recogido.'); }
  catch (e) { toast('No se pudo actualizar. Intenta de nuevo.'); }
  S.busy.delete(id); render();
}

/* Entregar y descontar la comisión van juntas: o pasan las dos o no pasa ninguna. */
async function delivered(id) {
  const o = byId(id);
  if (!canAct() || !o || o.driverId !== S.uid || o.estado !== 'recogido' || S.busy.has(id)) return;
  S.busy.add(id); render();
  try {
    await runTransaction(db, async (tx) => {
      const oref = doc(db, 'orders', id), wref = doc(db, 'wallets', S.uid);
      const os = await tx.get(oref), ws = await tx.get(wref);
      const d = os.exists() ? os.data() : null;
      if (!d || d.estado !== 'recogido' || d.driverId !== S.uid) throw new Error('state');
      if (!ws.exists()) throw new Error('nowallet');
      const com = (Number(d.tarifa) || 0) * COM_C, now = Date.now();
      tx.update(oref, { estado: 'entregado', entregadoEn: now });
      tx.update(wref, { saldoC: (Number(ws.data().saldoC) || 0) - com, lastOrder: id });
      tx.set(doc(db, 'movs', 'cm_' + id), { driverId: S.uid, tipo: 'comision', montoC: -com, orderId: id, creadoEn: now });
    });
    toast('Entrega registrada. Se descontó ' + cents(comC(o)) + ' de comisión.');
  } catch (e) {
    if (e && e.message === 'nowallet') { await ensureWallet(); toast('Se estaba abriendo tu saldo. Vuelve a tocar "Ya entregué".'); }
    else toast('No se pudo registrar la entrega. Intenta de nuevo.');
  }
  S.busy.delete(id); render();
}

async function cancelOrder(id) {
  if (!canAct() || S.busy.has(id)) return;
  S.cancelId = null; S.busy.add(id); render();
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'orders', id), s = await tx.get(ref);
      if (!s.exists() || s.data().estado !== 'abierto') throw new Error('taken');
      tx.update(ref, { estado: 'cancelado', canceladoEn: Date.now() });
    });
    toast('Pedido cancelado.');
  } catch (e) {
    toast(e && e.message === 'taken' ? 'Ya lo tomó un repartidor, no se puede cancelar.' : 'No se pudo cancelar. Intenta de nuevo.');
  }
  S.busy.delete(id); render();
}

/* ---------- fotos ---------- */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
    im.onload = () => {
      try {
        const w = im.naturalWidth, h = im.naturalHeight;
        let sc = Math.min(1, 1200 / Math.max(w, h)), q = 0.72, out = '';
        for (let t = 0; t < 10; t++) {
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(h * sc));
          const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
          cx.drawImage(im, 0, 0, cv.width, cv.height);
          out = cv.toDataURL('image/jpeg', q);
          if (out.length < 190000) break;
          if (q > 0.5) q -= 0.11; else sc *= 0.8;
        }
        URL.revokeObjectURL(url);
        if (out.length >= 250000) reject(new Error('big')); else resolve(out);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    im.src = url;
  });
}
async function uploadFoto(key, file) {
  if (!file || !S.uid) return;
  if (!/^image\//.test(file.type || '')) { toast('Elige una foto, no otro tipo de archivo.'); return; }
  S.uploading[key] = true; render();
  try {
    const img = await shrink(file);
    await setDoc(doc(db, 'docs', S.uid, 'fotos', key), { key, img, creadoEn: Date.now() });
    toast('Foto guardada.');
  } catch (e) { toast('No se pudo subir la foto. Intenta con otra.'); }
  delete S.uploading[key]; render();
}
async function uploadTicket(id, file) {
  if (!file || !S.uid) return;
  if (!/^image\//.test(file.type || '')) { toast('Elige una foto, no otro tipo de archivo.'); return; }
  const k = 'tk' + id; S.uploading[k] = true; render();
  try {
    const img = await shrink(file);
    await updateDoc(doc(db, 'recargas', id), { ticket: img });
    toast('Foto del ticket guardada.');
  } catch (e) { toast('No se pudo subir la foto del ticket. Intenta con otra.'); }
  delete S.uploading[k]; render();
}
async function sendDocs() {
  const slots = VER[S.role] || [];
  const have = slots.every((s) => safeImg(S.fotos[s.k]));
  if (!canAct() || !have || !S.consent || S.busy.has('verify')) return;
  S.busy.add('verify'); render();
  try {
    await updateDoc(doc(db, 'users', S.uid), { docsEn: Date.now(), fotos: slots.map((s) => s.k) });
    S.verEdit = false;
    toast('Documentos enviados. La administración los revisará.');
  } catch (e) { toast('No se pudieron enviar. Intenta de nuevo.'); }
  S.busy.delete('verify'); render();
}

/* ---------- recargas y administración ---------- */
async function requestRecharge(monto) {
  const id = newId(), codigo = newCode();
  await setDoc(doc(db, 'recargas', id), { id, codigo, driverId: S.uid, driverName: S.name || 'Repartidor', monto, estado: 'pendiente', creadoEn: Date.now() });
  return codigo;
}
async function resolveRecarga(id, ok) {
  const r = S.recargas.find((x) => x.id === id), k = 'rc' + id;
  if (!S.isAdmin || !r || r.estado !== 'pendiente' || S.busy.has(k)) return;
  S.busy.add(k); render();
  try {
    await runTransaction(db, async (tx) => {
      const rref = doc(db, 'recargas', id), rs = await tx.get(rref);
      if (!rs.exists() || rs.data().estado !== 'pendiente') throw new Error('done');
      const d = rs.data(), now = Date.now();
      if (ok) {
        const mc = Math.round(Number(d.monto) * 100);
        tx.set(doc(db, 'wallets', d.driverId), { saldoC: increment(mc) }, { merge: true });
        tx.set(doc(db, 'movs', 'rc_' + id), { driverId: d.driverId, tipo: 'recarga', montoC: mc, recargaId: id, creadoEn: now });
      }
      tx.update(rref, { estado: ok ? 'confirmada' : 'rechazada', resueltaEn: now });
    });
    toast(ok ? 'Recarga confirmada. Saldo acreditado.' : 'Recarga rechazada.');
  } catch (e) { toast(e && e.message === 'done' ? 'Esa recarga ya estaba resuelta.' : 'No se pudo completar. Intenta de nuevo.'); }
  S.busy.delete(k); render();
}
async function savePago() {
  if (!S.isAdmin) return;
  try { await setDoc(doc(db, 'config', 'pago'), { texto: $('#a-pago').value.trim() }); S.pagoDirty = false; toast('Datos de depósito guardados.'); }
  catch (e) { toast('No se pudo guardar. Intenta de nuevo.'); }
}
async function openReview(id) {
  S.review = id; S.revPhotos = null; S.motivo = ''; render();
  try {
    const snap = await getDocs(collection(db, 'docs', id, 'fotos')), m = {};
    snap.docs.forEach((d) => { const x = d.data(); if (x && safeImg(x.img)) m[d.id] = x.img; });
    if (S.review === id) { S.revPhotos = m; render(); }
  } catch (e) { if (S.review === id) { S.revPhotos = {}; render(); } toast('No se pudieron cargar las fotos.'); }
}
async function resolveAlta(id, ok, motivo) {
  const k = 'al' + id;
  if (!S.isAdmin || S.busy.has(k)) return;
  if (!ok && !motivo) { toast('Escribe el motivo del rechazo.'); return; }
  S.busy.add(k); render();
  try {
    await setDoc(doc(db, 'aprobaciones', id), { id, estado: ok ? 'aprobado' : 'rechazado', motivo: ok ? '' : motivo, en: Date.now(), por: S.uid });
    S.review = null; S.revPhotos = null; S.motivo = ''; S.suspId = null;
    toast(ok ? 'Cuenta aprobada.' : 'Cuenta rechazada.');
  } catch (e) { toast('No se pudo guardar. Intenta de nuevo.'); }
  S.busy.delete(k); render();
}
function copyCode(c) {
  if (!c) return;
  const fail = () => toast('Mantén presionado el código para copiarlo.');
  try { navigator.clipboard.writeText(c).then(() => toast('Código copiado.'), fail); } catch (e) { fail(); }
}

/* ---------- aviso de pedido nuevo (hoja inferior) ---------- */
function syncSheet() {
  if (!S.online || view() !== 'rider') { S.sheetId = null; S.sheetTaken = null; clearTimeout(S.sheetT); renderSheet(); return; }
  if (S.sheetTaken) { renderSheet(); return; }
  if (S.sheetId) {
    const cur = byId(S.sheetId);
    if (cur && cur.estado === 'abierto') { renderSheet(); return; }
    if (S.busy.has(S.sheetId)) { renderSheet(); return; } // lo estoy aceptando yo: no es "ya no disponible"
    if (!cur || cur.driverId !== S.uid) {
      const gone = S.sheetId;
      S.sheetTaken = { id: gone }; clearTimeout(S.sheetT);
      S.sheetT = setTimeout(() => { S.sheetTaken = null; S.queue = S.queue.filter((x) => x !== gone); S.sheetId = null; syncSheet(); }, 2400);
      renderSheet(); return;
    }
    S.queue = S.queue.filter((x) => x !== S.sheetId); S.sheetId = null; clearTimeout(S.sheetT);
  }
  while (S.queue.length) {
    const id = S.queue[0], o = byId(id);
    if (!o || o.estado !== 'abierto' || S.ignored.has(id) || !canTake(o)) { S.queue.shift(); continue; }
    S.sheetId = id; clearTimeout(S.sheetT);
    S.sheetT = setTimeout(() => { S.ignored.add(id); S.queue = S.queue.filter((x) => x !== id); S.sheetId = null; syncSheet(); }, 25000);
    break;
  }
  renderSheet();
}
function renderSheet(force) {
  const el = $('#sheet');
  const o = S.sheetId ? byId(S.sheetId) : null;
  const key = (S.sheetTaken ? 't' + S.sheetTaken.id : (o ? 'o' + o.id : '')) + '|' + (o && S.busy.has(o.id) ? 'b' : '');
  if (!force && key === S.sheetKey) return;
  S.sheetKey = key;
  if (S.sheetTaken) { el.hidden = false; el.innerHTML = '<div class="sheet-in"><p class="sheet-taken">Este pedido ya no está disponible.</p></div>'; return; }
  if (!o) { el.hidden = true; el.innerHTML = ''; return; }
  const busy = S.busy.has(o.id);
  el.hidden = false;
  el.innerHTML =
    '<div class="sheet-in" role="alertdialog" aria-label="Pedido nuevo">' +
    '<div class="timer" aria-hidden="true"><i></i></div>' +
    '<div class="sheet-title"><span class="pulse" aria-hidden="true"></span>Pedido nuevo <span class="folio">' + folio(o.id) + '</span></div>' +
    '<div class="money"><div class="fare">' + pesos(o.tarifa) + '<small>por el envío</small></div>' +
    '<div class="cash">' + (Number(o.cobro) > 0 ? 'Cobrar <b>' + pesos(o.cobro) + '</b>' : 'Sin cobro') + '</div></div>' +
    '<div class="line"><span class="k">Recoger en</span><span class="v">' + esc(o.shop) + ' · ' + esc(o.pickup) + '</span></div>' +
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' +
    '<div class="actions"><button class="btn ghost" type="button" data-act="ignore" data-id="' + esc(o.id) + '">Ignorar</button>' +
    '<button class="btn primary" type="button" data-act="accept" data-id="' + esc(o.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Aceptando…' : 'Aceptar') + '</button></div></div>';
}

/* ---------- pantallas ---------- */
const emptyBox = (title, text) => '<div class="empty"><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>';
function orderLines(o) {
  return '<div class="line"><span class="k">Cliente</span><span class="v">' + esc(o.cliente) + '</span></div>' +
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' +
    '<div class="line"><span class="k">Lleva</span><span class="v">' + esc(o.desc) + '</span></div>';
}
function moneyRow(o) {
  return '<hr class="tear"><div class="money"><div class="fare">' + pesos(o.tarifa) + '<small>envío</small></div>' +
    '<div class="cash">' + (Number(o.cobro) > 0 ? 'Cobrar <b>' + pesos(o.cobro) + '</b>' : 'Sin cobro') + '</div></div>';
}
const head = (o) => '<div class="head"><span class="folio">' + folio(o.id) + '</span><span class="chip ' + esc(o.estado) + '">' + LABEL[o.estado] + '</span><span class="ago">' + ago(o.creadoEn) + '</span></div>';
function prRow(name, chip, cls, meta, late) {
  return '<div class="pr"><div class="t"><b>' + esc(name) + '</b><span class="chip ' + cls + '">' + esc(chip) + '</span></div><small class="' + (late ? 'late' : '') + '">' + meta + '</small></div>';
}

function renderBanner() {
  const el = $('#banner'); let msg = '';
  if (S.dbErr) msg = 'Se perdió la conexión con los datos. Recarga la página.';
  else if (S.perm && S.roleOn) msg = 'No tienes permiso para ver estos datos. Cierra sesión y vuelve a entrar.';
  else if (navigator.onLine === false) msg = 'Sin internet. Los cambios se verán cuando vuelva la conexión.';
  el.hidden = !msg; el.textContent = msg;
}

function renderVerify() {
  const el = $('#viewVerify'), st = myStatus(), slots = VER[S.role] || [];
  const headH = '<h1>Verifica tu cuenta</h1>';
  if (st === 'revision' && !S.verEdit) {
    el.innerHTML = headH + '<div class="empty"><b>Tus documentos están en revisión</b><span>La administración los revisa. Esta pantalla se actualiza sola cuando te aprueben.</span></div>' +
      '<button class="btn ghost block" type="button" data-act="ver-edit">Cambiar mis documentos</button>';
    return;
  }
  const a = S.myAprob;
  let h = headH + '<p class="lede">' + (S.role === 'rider' ? 'Para recibir pedidos necesitamos 4 fotos. Solo sirven para confirmar quién eres.' : 'Para pedir motos necesitamos 3 fotos. Solo sirven para confirmar tu negocio.') + '</p>';
  if (st === 'rechazado') h += '<div class="banner"><b>No se aprobaron tus documentos.</b> ' + esc(a && a.motivo ? a.motivo : 'Revisa las fotos y súbelas de nuevo.') + '</div>';
  let ready = 0;
  slots.forEach((s) => {
    const im = safeImg(S.fotos[s.k]), up = !!S.uploading[s.k];
    if (im) ready++;
    h += '<div class="slot"><div class="t"><b>' + esc(s.t) + '</b>' + (up ? '<span class="chip abierto">Subiendo…</span>' : (im ? '<span class="chip entregado">Lista</span>' : '<span class="chip">Falta</span>')) + '</div>' +
      '<p class="hint">' + esc(s.h) + '</p>' + (im ? '<img class="thumb" src="' + im + '" alt="' + esc(s.t) + '">' : '') +
      '<input class="sr" type="file" accept="image/*" id="f-' + s.k + '" data-foto="' + s.k + '"' + (up ? ' disabled' : '') + '>' +
      '<label class="btn ' + (im ? 'ghost' : 'primary') + ' small" for="f-' + s.k + '">' + (im ? 'Cambiar foto' : 'Tomar o subir foto') + '</label></div>';
  });
  const all = ready === slots.length, sending = S.busy.has('verify');
  h += '<label class="check"><input type="checkbox" id="v-consent"' + (S.consent ? ' checked' : '') + '><span>Acepto que la administración use estas fotos solo para verificar mi identidad y mi negocio.</span></label>' +
    '<button class="btn primary block" type="button" data-act="ver-send"' + (all && S.consent && !sending ? '' : ' disabled') + '>' + (sending ? 'Enviando…' : 'Enviar a revisión') + '</button>' +
    (all ? '' : '<p class="hint">Sube las ' + slots.length + ' fotos para poder enviar.</p>');
  el.innerHTML = h;
}

function shopCard(o) {
  let s = '';
  if (o.estado === 'abierto') s = '<div class="status"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>Buscando repartidor</div>';
  else if (o.estado === 'asignado') s = '<div class="status"><b>' + esc(o.driverName || 'Un repartidor') + '</b> va por el pedido · ' + ago(o.asignadoEn || o.creadoEn) + '</div>';
  else if (o.estado === 'recogido') s = '<div class="status"><b>' + esc(o.driverName || 'El repartidor') + '</b> ya salió con el pedido</div>';
  else if (o.estado === 'entregado') s = '<div class="status">Entregado por <b>' + esc(o.driverName || 'el repartidor') + '</b></div>';
  let act = '';
  if (o.estado === 'abierto') {
    act = S.cancelId === o.id
      ? '<div class="actions"><button class="btn ghost small" type="button" data-act="cancel-no">Conservar</button><button class="btn danger small" type="button" data-act="cancel-yes" data-id="' + esc(o.id) + '">Sí, cancelar</button></div>'
      : '<div class="actions"><button class="btn ghost small" type="button" data-act="cancel" data-id="' + esc(o.id) + '"' + (S.busy.has(o.id) ? ' disabled' : '') + '>Cancelar pedido</button></div>';
  }
  return '<article class="order">' + head(o) + orderLines(o) + moneyRow(o) + s + act + '</article>';
}
function renderShop() {
  const list = S.orders;
  const active = list.filter((o) => o.estado === 'abierto' || o.estado === 'asignado' || o.estado === 'recogido');
  $('#shopNew').hidden = S.tab !== 'nuevo';
  const el = $('#shopList'); el.hidden = S.tab !== 'pedidos';
  if (S.tab === 'pedidos') {
    if (!S.openReady) el.innerHTML = emptyBox('Cargando pedidos', 'Un momento.');
    else if (!list.length) el.innerHTML = emptyBox('Aún no hay pedidos', 'Cuando pidas una moto, aquí ves quién la tomó y en qué va.');
    else el.innerHTML = '<h2 class="section">Mis pedidos</h2><div class="list">' + list.slice(0, 40).map(shopCard).join('') + '</div>';
  }
  if (!$('#o-pick').value && S.addr && document.activeElement !== $('#o-pick')) $('#o-pick').value = S.addr;
  return [{ id: 'nuevo', label: 'Nuevo pedido' }, { id: 'pedidos', label: 'Mis pedidos', badge: active.length }];
}

function acceptBtn(o, busy) {
  if (!S.walletReady || !S.wallet) return '<button class="btn ghost" type="button" disabled>Cargando saldo…</button>';
  if (!canTake(o)) return '<button class="btn ghost" type="button" data-act="tab" data-tab="saldo">Saldo insuficiente · Recargar</button>';
  return '<button class="btn primary" type="button" data-act="accept" data-id="' + esc(o.id) + '"' + (busy || !canAct() ? ' disabled' : '') + '>' + (busy ? 'Aceptando…' : 'Aceptar pedido') + '</button>';
}
function availCard(o) {
  return '<article class="order">' + head(o) +
    '<div class="line"><span class="k">Recoger en</span><span class="v">' + esc(o.shop) + ' · ' + esc(o.pickup) + '</span></div>' +
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' +
    '<div class="line"><span class="k">Lleva</span><span class="v">' + esc(o.desc) + '</span></div>' +
    moneyRow(o) +
    '<p class="hint">Comisión de ' + cents(comC(o)) + ' (5%) al entregar.</p>' +
    '<div class="actions">' + acceptBtn(o, S.busy.has(o.id)) + '</div></article>';
}
function tripCard(o) {
  const wa = waUrl(o.tel), busy = S.busy.has(o.id);
  const links = '<div class="links"><a href="' + esc(mapsUrl(o.pickup)) + '" target="_blank" rel="noopener">Mapa de recogida</a>' +
    '<a href="' + esc(mapsUrl(o.dest)) + '" target="_blank" rel="noopener">Mapa de entrega</a>' +
    (wa ? '<a href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp al cliente</a>' : '') + '</div>';
  let btn = '';
  if (o.estado === 'asignado') btn = '<button class="btn primary" type="button" data-act="picked" data-id="' + esc(o.id) + '"' + (busy ? ' disabled' : '') + '>Ya recogí el pedido</button>';
  if (o.estado === 'recogido') btn = '<button class="btn primary" type="button" data-act="delivered" data-id="' + esc(o.id) + '"' + (busy ? ' disabled' : '') + '>Ya entregué</button>';
  return '<article class="order">' + head(o) +
    '<div class="line"><span class="k">Recoger en</span><span class="v">' + esc(o.shop) + ' · ' + esc(o.pickup) + '</span></div>' +
    orderLines(o) +
    (o.tel ? '<div class="line"><span class="k">Teléfono del cliente</span><span class="v">' + esc(o.tel) + '</span></div>' : '') +
    moneyRow(o) + links + '<div class="actions">' + btn + '</div></article>';
}
function renderRider() {
  const open = S.orders.filter((o) => o.estado === 'abierto').sort((a, b) => b.creadoEn - a.creadoEn);
  const my = mine();
  const active = my.filter((o) => o.estado === 'asignado' || o.estado === 'recogido').sort((a, b) => (b.asignadoEn || 0) - (a.asignadoEn || 0));
  const done = my.filter((o) => o.estado === 'entregado').sort((a, b) => (b.entregadoEn || 0) - (a.entregadoEn || 0));
  const doneToday = done.filter((o) => isToday(o.entregadoEn || o.creadoEn));
  const earned = doneToday.reduce((s, o) => s + (Number(o.tarifa) || 0), 0);

  $('#riderHead').innerHTML =
    '<button type="button" class="switch" role="switch" id="onlineSw" aria-checked="' + (S.online ? 'true' : 'false') + '" data-act="online">' +
    '<span class="track" aria-hidden="true"></span><span><strong>' + (S.online ? 'En línea' : 'Desconectado') + '</strong>' +
    '<span class="sub">' + (S.online ? 'Deja Gasca abierta y la pantalla encendida para recibir avisos.' : 'Conéctate para recibir avisos de pedidos nuevos.') + '</span></span></button>' +
    '<div class="today"><div><b>' + (S.walletReady ? cents(saldoC()) : '…') + '</b><small>Saldo</small></div><div><b>' + doneToday.length + '</b><small>Viajes hoy</small></div><div><b>' + pesos(earned) + '</b><small>Ganado hoy</small></div></div>' +
    (S.walletReady && saldoC() < 2000 ? '<p class="warn">Saldo bajo. Recarga para seguir aceptando pedidos.</p>' : '');

  const av = $('#riderAvail'), tr = $('#riderTrips');
  av.hidden = S.tab !== 'disp'; tr.hidden = S.tab !== 'viajes';
  $('#riderWallet').hidden = S.tab !== 'saldo';
  if (S.tab === 'saldo') renderWallet();
  if (S.tab === 'disp') {
    if (!S.openReady) av.innerHTML = emptyBox('Cargando pedidos', 'Un momento.');
    else if (!open.length) av.innerHTML = emptyBox('Sin pedidos por ahora', S.online ? 'Cuando una tienda pida una moto, suena el aviso y aparece aquí.' : 'Conéctate arriba para que suene el aviso cuando llegue uno.');
    else av.innerHTML = open.map(availCard).join('');
  }
  if (S.tab === 'viajes') {
    let h = '';
    if (!active.length) h += emptyBox('Sin viajes en curso', 'Acepta un pedido en Disponibles y aquí ves el mapa, el teléfono y los pasos.');
    else h += active.map(tripCard).join('');
    if (done.length) h += '<div class="subhead">Entregados</div>' + done.slice(0, 8).map((o) =>
      '<article class="order">' + head(o) + '<div class="line"><span class="k">Entregó en</span><span class="v">' + esc(o.dest) + '</span></div><div class="money"><div class="cash">' + esc(o.shop) + '</div><div class="cash"><b>' + pesos(o.tarifa) + '</b></div></div></article>').join('');
    tr.innerHTML = h;
  }
  return [{ id: 'disp', label: 'Disponibles', badge: open.length }, { id: 'viajes', label: 'Mis viajes', badge: active.length }, { id: 'saldo', label: 'Saldo' }];
}

function movRow(m) {
  const plus = m.montoC >= 0;
  const lbl = m.tipo === 'recarga' ? 'Recarga' : 'Comisión ' + (m.orderId ? folio(m.orderId) : '');
  return '<div class="mov"><span>' + esc(lbl) + '<small>' + ago(m.creadoEn) + '</small></span><span class="' + (plus ? 'plus' : 'minus') + '">' + (plus ? '+' : '−') + cents(Math.abs(m.montoC)) + '</span></div>';
}
/* Ficha de depósito: monto exacto y número grande, separado de 4 en 4, para que la cajera lo teclee sin error. */
function fichaPago(texto, monto) {
  const m = String(texto).match(/\d[\d ]{8,22}\d/);
  const digits = m ? m[0].replace(/\s/g, '') : '';
  if (digits.length < 10 || digits.length > 20) return '<div class="line"><span class="k">Datos para depositar</span><span class="v pre">' + esc(texto) + '</span></div>';
  const rest = String(texto).replace(m[0], '').trim();
  return '<div class="ficha"><div class="line"><span class="k">Monto exacto</span><span class="amt">' + pesos(monto) + '</span></div>' +
    '<div class="line"><span class="k">Número para depositar</span><span class="num">' + esc(digits.replace(/(\d{4})(?=\d)/g, '$1 ')) + '</span></div>' +
    '<button class="btn ghost small" type="button" data-act="copy" data-v="' + esc(digits) + '">Copiar número</button>' +
    (rest ? '<span class="v pre">' + esc(rest) + '</span>' : '') +
    '<p class="hint">Enséñale esta pantalla a la cajera y confirma el monto y el número antes de pagar.</p></div>';
}
function renderWallet() {
  $('#rechargeForm').hidden = !S.rechargeOpen;
  $('#walletTop').innerHTML =
    '<div class="wallet"><div class="line"><span class="k">Saldo disponible</span><span class="saldo">' + (S.walletReady ? cents(saldoC()) : '…') + '</span></div>' +
    '<p class="hint">Cada envío entregado descuenta el 5% de su pago. Sin saldo suficiente no puedes aceptar pedidos nuevos.</p>' +
    '<button class="btn primary block" type="button" data-act="recharge-toggle">' + (S.rechargeOpen ? 'Cerrar' : 'Recargar saldo') + '</button></div>';
  const reqs = S.recargas.filter((r) => r.estado !== 'confirmada').sort((a, b) => b.creadoEn - a.creadoEn).slice(0, 5);
  let h = reqs.map((r) => {
    const pend = r.estado === 'pendiente', tk = safeImg(r.ticket), up = !!S.uploading['tk' + r.id];
    return '<article class="order"><div class="head"><span class="chip ' + (pend ? 'abierto' : '') + '">' + (pend ? 'Por pagar' : 'Rechazada') + '</span><span class="ago">' + ago(r.creadoEn) + '</span></div>' +
      (r.codigo ? '<div class="line"><span class="k">Tu código de pago</span><span class="code">' + esc(r.codigo) + '</span></div>' : '') +
      '<div class="money"><div class="fare">' + pesos(r.monto) + '</div><div class="cash">' + (pend ? 'Depósito pendiente' : 'No se acreditó') + '</div></div>' +
      (pend ? '<p class="hint">Deposita exactamente ' + pesos(r.monto) + ' en Oxxo o kiosco y di que la referencia es este código. Tu saldo se acredita cuando la administración confirme el depósito.</p>' +
        (S.pago ? fichaPago(S.pago, r.monto) : '<p class="hint">La administración aún no puso los datos de depósito. Pregúntalos antes de pagar.</p>') +
        (tk ? '<img class="thumb ticket" src="' + tk + '" alt="Ticket del depósito">' : '') +
        '<input class="sr" type="file" accept="image/*" id="t-' + esc(r.id) + '" data-ticket="' + esc(r.id) + '"' + (up ? ' disabled' : '') + '>' +
        '<div class="actions"><button class="btn ghost small" type="button" data-act="copy" data-v="' + esc(r.codigo || '') + '">Copiar código</button>' +
        '<label class="btn ghost small" for="t-' + esc(r.id) + '">' + (up ? 'Subiendo…' : (tk ? 'Cambiar foto del ticket' : 'Subir foto del ticket')) + '</label></div>' : '') +
      '</article>';
  }).join('');
  const movs = S.movs.slice().sort((a, b) => b.creadoEn - a.creadoEn).slice(0, 30);
  h += movs.length ? '<div class="subhead">Movimientos</div><div>' + movs.map(movRow).join('') + '</div>'
    : emptyBox('Sin movimientos', 'Tus recargas y la comisión de cada envío aparecen aquí.');
  $('#walletList').innerHTML = h;
}

/* Monitoreo en vivo para el dueño. */
const pres = (id) => S.presence[id] || null;
const isHere = (id) => { const p = pres(id); return !!p && Date.now() - (p.lastSeen || 0) < FRESH_MS; };
const isOnline = (id) => { const p = pres(id); return isHere(id) && !!p.online; };
const waitTxt = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'menos de 1 min' : m + ' min'; };
const lastAct = (o) => Math.max(o.asignadoEn || 0, o.recogidoEn || 0, o.entregadoEn || 0, o.creadoEn || 0);

function renderMonitor() {
  const el = $('#adminMonitor');
  const open = S.orders.filter((o) => o.estado === 'abierto').sort((a, b) => a.creadoEn - b.creadoEn);
  const going = S.orders.filter((o) => o.estado === 'asignado' || o.estado === 'recogido').sort((a, b) => (b.asignadoEn || 0) - (a.asignadoEn || 0));
  const doneToday = S.orders.filter((o) => o.estado === 'entregado' && isToday(o.entregadoEn || o.creadoEn)).sort((a, b) => (b.entregadoEn || 0) - (a.entregadoEn || 0));
  const riders = S.users.filter((u) => u.role === 'rider'), shops = S.users.filter((u) => u.role === 'shop');
  const onl = riders.filter((u) => isOnline(u.id)).length;

  let h = '<h2 class="section">En vivo</h2><div class="rider-head"><div class="today">' +
    '<div><b>' + open.length + '</b><small>Esperando</small></div><div><b>' + going.length + '</b><small>En curso</small></div>' +
    '<div><b>' + doneToday.length + '</b><small>Entregados hoy</small></div><div><b>' + onl + '</b><small>En línea</small></div></div></div>';

  h += '<div class="subhead">Esperando repartidor</div>';
  h += open.length ? open.map((o) => prRow(o.shop, folio(o.id), 'abierto', 'Lleva ' + waitTxt(o.creadoEn) + ' sin repartidor · ' + esc(o.dest), Date.now() - o.creadoEn > 300000)).join('') : '<p class="hint">Ningún pedido está esperando.</p>';

  h += '<div class="subhead">En curso</div>';
  h += going.length ? going.map((o) => prRow(o.driverName || 'Repartidor', o.estado === 'recogido' ? 'En camino a entregar' : 'Va por el pedido', 'asignado', esc(o.shop) + ' → ' + esc(o.dest) + ' · ' + folio(o.id) + ' · ' + ago(o.asignadoEn || o.creadoEn))).join('') : '<p class="hint">Ningún repartidor tiene un pedido ahora.</p>';

  h += '<div class="subhead">Entregados hoy</div>';
  h += doneToday.length ? doneToday.slice(0, 8).map((o) => prRow(o.driverName || 'Repartidor', 'Entregado', 'entregado', esc(o.shop) + ' · ' + folio(o.id) + ' · ' + ago(o.entregadoEn || o.creadoEn))).join('') : '<p class="hint">Todavía no hay entregas hoy.</p>';

  const rr = riders.map((u) => {
    const trip = going.find((o) => o.driverId === u.id);
    const mo = S.orders.filter((o) => o.driverId === u.id);
    const hoy = mo.filter((o) => o.estado === 'entregado' && isToday(o.entregadoEn || o.creadoEn)).length;
    const last = mo.reduce((m, o) => Math.max(m, lastAct(o)), 0);
    const ps = personStatus(u, S.aprobs[u.id]);
    let st, cls, rank;
    if (ps !== 'aprobado') { st = verLabel(ps); cls = ''; rank = 4; }
    else if (trip) { st = trip.estado === 'recogido' ? 'En camino a entregar' : 'Va por el pedido'; cls = 'asignado'; rank = 0; }
    else if (isOnline(u.id)) { st = 'En línea, esperando pedido'; cls = 'entregado'; rank = 1; }
    else if (isHere(u.id)) { st = 'Conectado, sin recibir pedidos'; cls = ''; rank = 2; }
    else { st = 'Sin conexión'; cls = ''; rank = 3; }
    const sal = S.wallets[u.id] ? cents(S.wallets[u.id].saldoC) : '$0';
    return { rank, html: prRow(u.name, st, cls, 'Saldo ' + sal + ' · ' + hoy + ' entregas hoy · ' + (last ? 'última actividad ' + ago(last) : 'sin viajes todavía') + ' · se unió ' + ago(u.creadoEn)) };
  }).sort((a, b) => a.rank - b.rank);
  h += '<div class="subhead">Repartidores (' + riders.length + ')</div>';
  h += rr.length ? rr.map((x) => x.html).join('') : emptyBox('Nadie se ha dado de alta', 'Cuando un repartidor cree su cuenta, aparece aquí.');

  const sr = shops.map((u) => {
    const os = S.orders.filter((o) => o.shopId === u.id);
    const wait = os.filter((o) => o.estado === 'abierto'), curso = os.filter((o) => o.estado === 'asignado' || o.estado === 'recogido');
    const hoy = os.filter((o) => o.estado !== 'cancelado' && isToday(o.creadoEn)).length;
    const ps = personStatus(u, S.aprobs[u.id]);
    let st, cls, rank;
    if (ps !== 'aprobado') { st = verLabel(ps); cls = ''; rank = 4; }
    else if (wait.length) { st = 'Esperando repartidor (' + wait.length + ')'; cls = 'abierto'; rank = 0; }
    else if (curso.length) { st = curso.length + ' en curso'; cls = 'asignado'; rank = 1; }
    else if (isHere(u.id)) { st = 'Conectado'; cls = 'entregado'; rank = 2; }
    else { st = 'Sin conexión'; cls = ''; rank = 3; }
    return { rank, html: prRow(u.name, st, cls, hoy + ' pedidos hoy · ' + os.length + ' en total · se unió ' + ago(u.creadoEn)) };
  }).sort((a, b) => a.rank - b.rank);
  h += '<div class="subhead">Restaurantes y tiendas (' + shops.length + ')</div>';
  h += sr.length ? sr.map((x) => x.html).join('') : emptyBox('Nadie se ha dado de alta', 'Cuando una tienda cree su cuenta, aparece aquí.');
  el.innerHTML = h;
}

function altaCard(u) {
  const slots = VER[u.role] || [], open = S.review === u.id, busy = S.busy.has('al' + u.id);
  const n = Array.isArray(u.fotos) ? u.fotos.length : 0;
  let h = '<article class="order"><div class="head"><span class="folio">' + esc(u.name) + '</span><span class="chip abierto">' + esc(ROLE_LBL[u.role] || '') + '</span><span class="ago">' + ago(u.docsEn) + '</span></div>' +
    (u.role === 'shop' && u.addr ? '<div class="line"><span class="k">Dirección</span><span class="v">' + esc(u.addr) + '</span></div>' : '') +
    '<div class="line"><span class="k">Fotos enviadas</span><span class="v">' + n + ' de ' + slots.length + '</span></div>';
  if (!open) return h + '<div class="actions"><button class="btn primary small" type="button" data-act="rev-open" data-id="' + esc(u.id) + '">Revisar documentos</button></div></article>';
  if (!S.revPhotos) return h + emptyBox('Cargando fotos', 'Un momento.') + '</article>';
  h += '<div class="photos">' + slots.map((s) => {
    const im = safeImg(S.revPhotos[s.k]);
    return '<figure class="ph"><figcaption>' + esc(s.t) + '</figcaption>' + (im ? '<img src="' + im + '" alt="' + esc(s.t) + '" data-act="zoom">' : '<div class="ph-miss">No la envió</div>') + '</figure>';
  }).join('') + '</div>' +
    '<div class="field"><label for="a-motivo">Motivo si la rechazas</label><input id="a-motivo" type="text" maxlength="160" placeholder="Ej. La placa no se lee en la foto" value="' + esc(S.motivo) + '"></div>' +
    '<div class="actions"><button class="btn ghost small" type="button" data-act="rev-close">Cerrar</button>' +
    '<button class="btn danger small" type="button" data-act="alta-no" data-id="' + esc(u.id) + '"' + (busy ? ' disabled' : '') + '>Rechazar</button>' +
    '<button class="btn primary small" type="button" data-act="alta-ok" data-id="' + esc(u.id) + '"' + (busy ? ' disabled' : '') + '>Aprobar</button></div></article>';
  return h;
}
function renderAltas() {
  const el = $('#adminAltas');
  if (document.activeElement && document.activeElement.id === 'a-motivo') return;
  const all = S.users.map((u) => ({ u, st: personStatus(u, S.aprobs[u.id]) }));
  const rev = all.filter((x) => x.st === 'revision').sort((a, b) => (a.u.docsEn || 0) - (b.u.docsEn || 0));
  const apr = all.filter((x) => x.st === 'aprobado');
  const oth = all.filter((x) => x.st === 'incompleto' || x.st === 'rechazado');
  let h = '<h2 class="section">Altas</h2><div class="subhead">Por revisar (' + rev.length + ')</div>';
  h += rev.length ? rev.map((x) => altaCard(x.u)).join('') : '<p class="hint">Nadie está esperando aprobación.</p>';
  h += '<div class="subhead">Aprobados (' + apr.length + ')</div>';
  h += apr.length ? apr.map((x) => {
    const u = x.u, a = S.aprobs[u.id] || {};
    return '<div class="pr"><div class="t"><b>' + esc(u.name) + '</b><span class="chip entregado">Aprobado</span></div><small>' + esc(ROLE_LBL[u.role] || '') + ' · aprobado ' + ago(a.en || u.creadoEn) + '</small>' +
      (S.suspId === u.id
        ? '<div class="actions"><button class="btn ghost small" type="button" data-act="susp-no">Conservar</button><button class="btn danger small" type="button" data-act="susp-yes" data-id="' + esc(u.id) + '">Sí, suspender</button></div>'
        : '<div class="actions"><button class="btn ghost small" type="button" data-act="susp" data-id="' + esc(u.id) + '">Suspender</button></div>') + '</div>';
  }).join('') : '<p class="hint">Todavía no has aprobado a nadie.</p>';
  if (oth.length) {
    h += '<div class="subhead">Sin enviar o rechazados (' + oth.length + ')</div>' + oth.map((x) => {
      const a = S.aprobs[x.u.id];
      return prRow(x.u.name, verLabel(x.st), '', esc(ROLE_LBL[x.u.role] || '') + (x.st === 'rechazado' && a && a.motivo ? ' · ' + esc(a.motivo) : '') + ' · se unió ' + ago(x.u.creadoEn));
    }).join('');
  }
  el.innerHTML = h;
}

function renderAdmin() {
  const pend = S.recargas.filter((r) => r.estado === 'pendiente').sort((a, b) => a.creadoEn - b.creadoEn);
  const rc = $('#adminRecargas'), sd = $('#adminSaldos');
  rc.hidden = S.tab !== 'recargas'; sd.hidden = S.tab !== 'saldos';
  $('#adminSearch').hidden = S.tab !== 'recargas'; $('#adminAjustes').hidden = S.tab !== 'ajustes';
  $('#adminMonitor').hidden = S.tab !== 'monitor';
  $('#adminAltas').hidden = S.tab !== 'altas';
  if (S.tab === 'monitor') renderMonitor();
  if (S.tab === 'altas') renderAltas();
  if (S.tab === 'ajustes' && !S.pagoDirty && document.activeElement !== $('#a-pago')) $('#a-pago').value = S.pago;
  if (S.tab === 'recargas') {
    const q = normCode($('#a-buscar').value);
    const shown = q ? S.recargas.filter((r) => normCode(r.codigo).indexOf(q) >= 0).sort((a, b) => b.creadoEn - a.creadoEn) : pend;
    let h = '<h2 class="section">' + (q ? 'Resultado de la búsqueda' : 'Recargas por confirmar') + '</h2>';
    if (!shown.length) h += q ? emptyBox('Sin coincidencias', 'Ningún código se parece a ese. Revisa la referencia del depósito.') : emptyBox('Nada pendiente', 'Cuando un repartidor genere un código de pago, aparece aquí para que lo confirmes.');
    else h += shown.map((r) => {
      const dis = S.busy.has('rc' + r.id) ? ' disabled' : '', open = r.estado === 'pendiente', tk = safeImg(r.ticket);
      return '<article class="order"><div class="head"><span class="folio">' + esc(r.driverName || 'Repartidor') + '</span><span class="chip ' + (open ? 'abierto' : (r.estado === 'confirmada' ? 'entregado' : '')) + '">' + (open ? 'Por confirmar' : (r.estado === 'confirmada' ? 'Confirmada' : 'Rechazada')) + '</span><span class="ago">' + ago(r.creadoEn) + '</span></div>' +
        (r.codigo ? '<div class="line"><span class="k">Código de referencia</span><span class="code">' + esc(r.codigo) + '</span></div>' : '') +
        '<div class="money"><div class="fare">' + pesos(r.monto) + '</div><div class="cash">Debe coincidir con el depósito</div></div>' +
        (tk ? '<figure class="ph"><figcaption>Ticket del depósito</figcaption><img src="' + tk + '" alt="Ticket del depósito" data-act="zoom"></figure>' : '') +
        (open ? '<div class="actions"><button class="btn ghost small" type="button" data-act="rc-no" data-id="' + esc(r.id) + '"' + dis + '>Rechazar</button>' +
          '<button class="btn primary small" type="button" data-act="rc-ok" data-id="' + esc(r.id) + '"' + dis + '>Confirmar depósito</button></div>' : '') + '</article>';
    }).join('');
    rc.innerHTML = h;
  }
  if (S.tab === 'saldos') {
    const nm = {}; S.users.forEach((u) => { nm[u.id] = u.name; });
    const ids = Object.keys(S.wallets).sort((a, b) => (S.wallets[b].saldoC || 0) - (S.wallets[a].saldoC || 0));
    const com = S.movs.filter((m) => m.tipo === 'comision').reduce((s, m) => s - m.montoC, 0);
    const rec = S.movs.filter((m) => m.tipo === 'recarga').reduce((s, m) => s + m.montoC, 0);
    let t = '<h2 class="section">Saldos</h2><div class="rider-head"><div class="today"><div><b>' + cents(com) + '</b><small>Comisiones</small></div><div><b>' + cents(rec) + '</b><small>Recargado</small></div></div></div>';
    t += ids.length ? '<div>' + ids.map((id) => '<div class="drv"><span>' + esc(nm[id] || 'Repartidor') + '</span><b class="' + ((S.wallets[id].saldoC || 0) <= 0 ? 'neg' : '') + '">' + cents(S.wallets[id].saldoC) + '</b></div>').join('') + '</div>'
      : emptyBox('Sin repartidores todavía', 'Aquí ves el saldo de cada repartidor cuando recargue o entregue su primer pedido.');
    sd.innerHTML = t;
  }
  return [
    { id: 'monitor', label: 'En vivo', badge: S.orders.filter((o) => o.estado === 'abierto').length },
    { id: 'altas', label: 'Altas', badge: S.users.filter((u) => personStatus(u, S.aprobs[u.id]) === 'revision').length },
    { id: 'recargas', label: 'Recargas', badge: pend.length },
    { id: 'saldos', label: 'Saldos' },
    { id: 'ajustes', label: 'Depósito' }
  ];
}

function renderTabs(tabs) {
  const nav = $('#tabs'); nav.hidden = !tabs;
  if (!tabs) return;
  $('#tabsIn').style.setProperty('--n', tabs.length);
  $('#tabsIn').setAttribute('data-n', tabs.length);
  $('#tabsIn').innerHTML = tabs.map((t) =>
    '<button type="button" role="tab" class="tab" data-act="tab" data-tab="' + t.id + '" aria-selected="' + (S.tab === t.id) + '">' + esc(t.label) +
    (t.badge ? '<span class="badge">' + t.badge + '</span>' : '') + '</button>').join('');
}

function render() {
  const v = view();
  const show = (sel, on) => { $(sel).hidden = !on; };
  show('#viewLoading', v === 'loading');
  show('#viewAuth', v === 'auth' || v === 'profile');
  show('#viewOwner', v === 'owner');
  show('#viewVerify', v === 'verify');
  show('#viewShop', v === 'shop');
  show('#viewRider', v === 'rider');
  show('#viewAdmin', v === 'admin');
  if (v === 'profile' && S.authMode !== 'profile') setMode('profile');
  if (v === 'auth' && S.authMode === 'profile') setMode('login');
  if (v === 'owner') $('#ownerMail').textContent = 'Correo: ' + S.email;
  const who = $('#who');
  who.hidden = !S.user || v === 'loading';
  if (S.user) who.textContent = v === 'admin' ? 'Dueño' : (S.name ? ({ shop: 'Tienda · ', rider: 'Repartidor · ' }[S.role] || '') + S.name : 'Salir');
  renderBanner();
  if (v !== 'rider') { S.sheetId = null; if (!$('#sheet').hidden) { $('#sheet').hidden = true; S.sheetKey = ''; } }
  let tabs = null;
  if (v === 'verify') renderVerify();
  if (v === 'shop') tabs = renderShop();
  if (v === 'rider') tabs = renderRider();
  if (v === 'admin') tabs = renderAdmin();
  renderTabs(tabs);
  $('#orderBtn').disabled = !canAct();
}

/* ---------- formularios ---------- */
$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canAct() || view() !== 'shop') return;
  ensureAudio();
  const btn = $('#orderBtn'); btn.disabled = true; btn.textContent = 'Enviando…';
  const tarifa = Math.round(Number($('#o-tarifa').value) || 0);
  const cobro = Math.round((Number($('#o-cobro').value) || 0) * 100) / 100;
  const o = {
    shopId: S.uid, shop: S.name, pickup: $('#o-pick').value.trim(), cliente: $('#o-cliente').value.trim(), tel: $('#o-tel').value.trim(),
    dest: $('#o-dest').value.trim(), desc: $('#o-desc').value.trim(), cobro, tarifa
  };
  try {
    if (tarifa < 1 || tarifa > 2000) throw new Error('tarifa');
    const id = await createOrder(o);
    ['o-cliente', 'o-tel', 'o-dest', 'o-desc', 'o-cobro'].forEach((i) => { $('#' + i).value = ''; });
    S.tab = 'pedidos';
    toast('Pedido ' + folio(id) + ' enviado a los repartidores.');
  } catch (err) {
    toast(err && err.message === 'tarifa' ? 'El pago al repartidor debe ser entre $1 y $2,000.' : 'No se pudo enviar el pedido. Intenta de nuevo.');
  }
  btn.textContent = 'Pedir moto'; render();
});
$('#rechargeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canAct()) return;
  const monto = Math.round(Number($('#r-monto').value) || 0);
  if (monto < 10 || monto > 5000) { toast('La recarga debe ser de $10 a $5,000.'); return; }
  const btn = $('#rechargeBtn'); btn.disabled = true;
  try {
    const codigo = await requestRecharge(monto);
    $('#r-monto').value = ''; S.rechargeOpen = false;
    toast('Tu código de pago es ' + codigo + '.');
  } catch (err) { toast('No se pudo enviar la recarga. Intenta de nuevo.'); }
  btn.disabled = false; render();
});
$('#a-buscar').addEventListener('input', () => render());
$('#a-pago').addEventListener('input', () => { S.pagoDirty = true; });
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'a-motivo') S.motivo = e.target.value; });
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || !t.getAttribute) return;
  if (t.getAttribute('data-foto')) {
    const f = t.files && t.files[0], k = t.getAttribute('data-foto'); t.value = '';
    if (f) uploadFoto(k, f);
  } else if (t.getAttribute('data-ticket')) {
    const f = t.files && t.files[0], k = t.getAttribute('data-ticket'); t.value = '';
    if (f) uploadTicket(k, f);
  } else if (t.id === 'v-consent') { S.consent = t.checked; render(); }
});
function openZoom(src) { if (!safeImg(src)) return; $('#zoom img').src = src; $('#zoom').hidden = false; }
function closeZoom() { $('#zoom').hidden = true; $('#zoom img').removeAttribute('src'); }
$('#zoom').addEventListener('click', closeZoom);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#zoom').hidden) closeZoom(); });
window.addEventListener('online', render);
window.addEventListener('offline', render);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
  if (act === 'menu') { if (confirm('¿Cerrar sesión?')) doSignOut(); }
  else if (act === 'signout') doSignOut();
  else if (act === 'mode-login') { setMode('login'); }
  else if (act === 'mode-signup') { setMode('signup'); }
  else if (act === 'mode-owner') { setMode('owner'); }
  else if (act === 'owner-create') ownerCreate();
  else if (act === 'owner-check') ownerCheck();
  else if (act === 'owner-resend') ownerResend();
  else if (act === 'reset') resetPass();
  else if (act === 'tab') { S.tab = b.getAttribute('data-tab'); S.cancelId = null; render(); }
  else if (act === 'cancel') { S.cancelId = id; render(); }
  else if (act === 'cancel-no') { S.cancelId = null; render(); }
  else if (act === 'cancel-yes') cancelOrder(id);
  else if (act === 'accept') { ensureAudio(); accept(id); }
  else if (act === 'ignore') { S.ignored.add(id); S.queue = S.queue.filter((x) => x !== id); S.sheetId = null; clearTimeout(S.sheetT); syncSheet(); }
  else if (act === 'recharge-toggle') { S.rechargeOpen = !S.rechargeOpen; render(); }
  else if (act === 'amt') { $('#r-monto').value = b.getAttribute('data-v'); }
  else if (act === 'rc-ok') resolveRecarga(id, true);
  else if (act === 'rc-no') resolveRecarga(id, false);
  else if (act === 'copy') copyCode(b.getAttribute('data-v'));
  else if (act === 'save-pago') savePago();
  else if (act === 'ver-edit') { S.verEdit = true; render(); }
  else if (act === 'ver-send') sendDocs();
  else if (act === 'rev-open') openReview(id);
  else if (act === 'rev-close') { S.review = null; S.revPhotos = null; S.motivo = ''; render(); }
  else if (act === 'alta-ok') resolveAlta(id, true);
  else if (act === 'alta-no') resolveAlta(id, false, (S.motivo || '').trim());
  else if (act === 'susp') { S.suspId = id; render(); }
  else if (act === 'susp-no') { S.suspId = null; render(); }
  else if (act === 'susp-yes') resolveAlta(id, false, 'Cuenta suspendida por la administración.');
  else if (act === 'zoom') openZoom(b.getAttribute('src'));
  else if (act === 'picked') picked(id);
  else if (act === 'delivered') delivered(id);
  else if (act === 'online') {
    S.online = !S.online;
    if (S.online) { ensureAudio(); beep([784]); queueOpen(); holdWake(); } else { S.queue = []; releaseWake(); }
    syncSheet(); render(); pushPresence();
  }
});

/* ---------- inicio ---------- */
setMode('login');
render();
setInterval(() => { if (S.user && view() !== 'verify') render(); }, 30000);
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); }); }
