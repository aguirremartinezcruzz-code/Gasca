/* Gasca · entregas certificadas. App web con Firebase (cuentas + Firestore). */
import { FIREBASE_CONFIG, OWNER_EMAIL } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail, reload
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
  orderBy, limit, onSnapshot, runTransaction, increment, writeBatch
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
const COM_C = 13; // la comisión es el 13%: 13 centavos por cada peso del envío

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
    incs: [], incReady: false, incMine: new Set(), regRead: false, regOk: false, regTop: 0, codes: {}, orders: [], openOrders: [], myOrders: [], known: new Set(), openReady: false, prev: new Map(),
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
  ['#viewVerify', '#shopList', '#riderHead', '#riderAvail', '#riderTrips', '#walletTop', '#walletList', '#adminMonitor', '#adminAltas', '#adminRecargas', '#adminSaldos', '#adminIncid', '#sheet']
    .forEach((s) => { const el = $(s); if (el) el.innerHTML = ''; });
  ['#o-pick', '#o-prod', '#p-calle', '#p-col', '#p-ciudad', '#p-mun', '#o-cliente', '#o-tel', '#o-dest', '#o-calle', '#o-num', '#o-int', '#o-col', '#o-ref', '#o-desc', '#o-cobro', '#o-tarifa', '#r-monto', '#a-pago', '#a-buscar']
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
const mapsUrl = (a) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(a || '').split(' — ')[0]);
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
    { k: 'ine', t: 'INE por el frente', h: 'Foto de tu INE por el frente. Que se vean tu foto y tus datos completos.' },
    { k: 'ine_atras', t: 'INE por atrás', h: 'Foto de tu INE por la parte de atrás. Que se lea todo.' },
    { k: 'licencia', t: 'Licencia de conducir', h: 'Por el frente, vigente y legible.' },
    { k: 'tarjeta', t: 'Tarjeta de circulación', h: 'Foto de la tarjeta de circulación de tu moto. Que se lea completa.' },
    { k: 'moto', t: 'Foto de la moto', h: 'Toda la moto de lado, de la llanta de adelante a la de atrás.' },
    { k: 'placa', t: 'Placa de la moto', h: 'La moto vista por detrás, con la placa bien legible.' }
  ],
  shop: [
    { k: 'ine', t: 'INE del dueño o encargado', h: 'Foto de la INE por el frente. Que se vean la foto y los datos completos.' },
    { k: 'domicilio', t: 'Comprobante de domicilio', h: 'Recibo de luz, agua, teléfono o estado de cuenta reciente. Que se vea completo.' },
    { k: 'local', t: 'Foto del local', h: 'El frente de tu negocio. Si vendes desde tu casa, una foto de la casa.' }
  ]
};
const ROLE_LBL = { rider: 'Repartidor', shop: 'Tienda o restaurante' };
const TEL_DOM = '@clientes.gasca.app';
const isCli = (u) => !!u && u.role === 'shop' && typeof u.addr === 'string' && u.addr.indexOf('CLIENTE') === 0;
const roleLbl = (u) => (isCli(u) ? 'Servicio de mandadito' : ROLE_LBL[u && u.role] || '');
const VER_CLI = [
  { k: 'local', t: 'Selfie', h: 'Una foto de tu cara, de frente y con buena luz. Sin lentes oscuros ni gorra.', selfie: true },
  { k: 'ine', t: 'INE por el frente', h: 'Foto de tu INE por el frente. Que se vean tu foto y tus datos completos.' },
  { k: 'ine_atras', t: 'INE por atrás', h: 'Foto de tu INE por la parte de atrás. Que se lea todo.' }
];
const slotsFor = (u) => (isCli(u) ? VER_CLI : VER[u && u.role] || []);
const telEmail = (x) => { const d = String(x || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) + TEL_DOM : ''; };
const telOf = (email) => String(email || '').endsWith(TEL_DOM) ? email.slice(0, -TEL_DOM.length) : '';
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
(function injectCli() {
  const sh = af.querySelector('input[value="shop"]');
  if (sh) { const l = sh.closest('label'); l.querySelector('b').textContent = 'Para negocios'; l.querySelector('small').textContent = 'Soy tienda o restaurante'; }
  const lg = af.querySelector('#authRoles .legend'); if (lg) lg.textContent = '¿Quién eres?';
  const r = af.querySelector('input[value="rider"]'); if (!r) return;
  const lab = r.closest('label'), n = lab.cloneNode(true);
  n.querySelector('input').value = 'cliente'; n.querySelector('b').textContent = 'Para envíos personales'; n.querySelector('small').textContent = 'Quiero enviar algo';
  lab.after(n);
  const f = document.createElement('div'); f.className = 'field'; f.id = 'fTel'; f.hidden = true;
  f.innerHTML = '<label for="a-tel">Tu teléfono (10 dígitos)</label><input id="a-tel" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="Ej. 3111234567">';
  $('#fEmail').before(f);
})();
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
  { const cl = form && roleVal() === 'cliente';
    $('#fEmail').hidden = pr || cl; $('#fTel').hidden = !(su && cl);
    $('#a-email').type = 'text';
    document.querySelector('label[for="a-email"]').textContent = m === 'login' ? 'Correo o teléfono' : 'Correo';
    if (cl) { $('#lblName').textContent = 'Tu nombre completo'; $('#a-name').placeholder = 'Ej. María López'; }
    if (cl) $('#authHint').textContent = 'Después te pediremos una selfie y tu INE por los dos lados para aprobar tu cuenta.';
    else $('#authHint').textContent = 'Después te pediremos fotos de tus documentos para aprobar tu cuenta.';
    if (m === 'login') $('#a-email').placeholder = 'correo o teléfono de 10 dígitos'; else $('#a-email').placeholder = 'tucorreo@ejemplo.com'; }
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
  if (c === 'auth/email-already-in-use') return (roleVal() === 'cliente' ? 'Ese teléfono ya tiene cuenta. Toca "Ya tengo cuenta".' : 'Ese correo ya tiene cuenta. Toca "Ya tengo cuenta".');
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found' || c === 'auth/invalid-login-credentials') return 'Correo, teléfono o contraseña incorrectos.';
  if (c === 'auth/weak-password') return 'La contraseña debe tener al menos 6 caracteres.';
  if (c === 'auth/invalid-email') return 'Ese correo no se ve bien. Revísalo.';
  if (c === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e intenta de nuevo.';
  if (c === 'auth/network-request-failed') return 'No hay internet. Revisa tu conexión.';
  if (c === 'permission-denied') return 'No se pudo guardar tu cuenta. Avisa a la administración.';
  return 'No se pudo completar. Intenta de nuevo.';
}
async function createProfile(uid, p) {
  const cli = p.role === 'cliente';
  const rec = { id: uid, role: cli ? 'shop' : p.role, name: p.name, creadoEn: Date.now() };
  if (cli) rec.addr = 'CLIENTE · Tel ' + p.tel; else if (p.role === 'shop') rec.addr = p.addr;
  await setDoc(doc(db, 'users', uid), rec);
}
function setBusy(b) { S.authBusy = b; $('#authBtn').disabled = b; $('#authBtn2').disabled = b; }

af.addEventListener('change', (e) => { if (e.target && e.target.name === 'role') { const m = S.authMode; const keep = S.authErr; setMode(m); S.authErr = keep; showErr(); } });
af.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (S.authBusy) return;
  const m = S.authMode;
  let email = $('#a-email').value.trim().toLowerCase(); const pass = $('#a-pass').value;
  if (email && email.indexOf('@') < 0 && /^[\d\s+()-]+$/.test(email)) email = telEmail(email);
  const role = roleVal(), tel = $('#a-tel').value.replace(/\D/g, '').slice(-10), name = $('#a-name').value.trim(), addr = $('#a-addr').value.trim();
  const fail = (msg) => { S.authErr = msg; showErr(); };
  S.authErr = ''; showErr();
  const needProfile = () => {
    if (!role) return 'Elige si eres tienda, repartidor o cliente.';
    if (role === 'cliente' && m === 'signup' && tel.length !== 10) return 'Escribe tu número de teléfono de 10 dígitos.';
    if (name.length < 2) return 'Escribe tu nombre.';
    if (role === 'shop' && addr.length < 5) return 'Escribe la dirección de tu negocio.';
    return '';
  };
  try {
    if (m === 'login' || m === 'owner') {
      if (!email || !pass) return fail('Escribe tu correo o teléfono y tu contraseña.');
      if (m === 'owner' && (!OWNER_OK || email !== OWNER)) return fail('Ese correo no es el del dueño.');
      setBusy(true);
      await signInWithEmailAndPassword(auth, email, pass);
    } else if (m === 'signup') {
      const pe = needProfile(); if (pe) return fail(pe);
      if (role === 'cliente') email = telEmail(tel);
      if (!email) return fail('Escribe tu correo.');
      if (pass.length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
      if (OWNER_OK && email === OWNER) return fail('Ese correo es del dueño. Usa "Soy el dueño".');
      setBusy(true); S.creating = true; render();
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await createProfile(cred.user.uid, { role, name, addr, tel });
    } else if (m === 'profile') {
      const pe = needProfile(); if (pe) return fail(pe);
      const ptel = telOf(S.user && S.user.email);
      if (role === 'cliente' && !ptel) return fail('Para ser cliente crea tu cuenta con tu teléfono. Toca Salir y elige "Crear cuenta".');
      setBusy(true);
      await createProfile(S.uid, { role, name, addr, tel: ptel });
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
  const raw = $('#a-email').value.trim().toLowerCase();
  if (raw && raw.indexOf('@') < 0 && /^[\d\s+()-]+$/.test(raw)) { S.authErr = 'Si olvidaste tu contraseña, escríbenos por WhatsApp al ' + SUPPORT_TEL + ' y te ayudamos.'; showErr(); return; }
  const email = raw;
  if (!email) { S.authErr = 'Escribe tu correo arriba y vuelve a tocar "Olvidé mi contraseña".'; showErr(); return; }
  try { await sendPasswordResetEmail(auth, email); S.authErr = ''; showErr(); toast('Si ese correo tiene cuenta, te enviamos un enlace para cambiar la contraseña.'); }
  catch (err) { S.authErr = authMsg(err); showErr(); }
}
async function doSignOut() {
  if (S.role === 'rider' && S.myOrders.some((o) => o.driverId === S.uid && (o.estado === 'asignado' || o.estado === 'recogido'))) {
    toast('Tienes un pedido activo. Termínalo, o repórtalo con "Tengo un problema", antes de cerrar sesión.');
    return;
  }
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
    if (S.profile) { S.role = S.profile.role; S.name = S.profile.name || ''; S.addr = isCli(S.profile) ? '' : (S.profile.addr || ''); if (!S.tab) S.tab = S.role === 'rider' ? 'disp' : 'nuevo'; }
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
    listen(roleUnsubs, query(collection(db, 'orders'), where('driverId', '==', S.uid)), onMyOrders);
    listen(roleUnsubs, doc(db, 'wallets', S.uid), (s) => { S.wallet = s.exists() ? s.data() : null; S.walletReady = true; if (S.online) queueOpen(); syncSheet(); render(); });
    listen(roleUnsubs, query(collection(db, 'movs'), where('driverId', '==', S.uid)), (snap) => { S.movs = snap.docs.map((d) => d.data()); render(); });
    listen(roleUnsubs, query(collection(db, 'recargas'), where('driverId', '==', S.uid)), (snap) => { S.recargas = snap.docs.map((d) => d.data()).filter((r) => r && r.id && r.estado); render(); });
    listen(roleUnsubs, doc(db, 'config', 'pago'), (s) => { S.pago = (s.exists() && s.data().texto) || ''; render(); });
  } else {
    listen(roleUnsubs, query(collection(db, 'orders'), where('shopId', '==', S.uid)), onShopOrders);
    listen(roleUnsubs, query(collection(db, 'codes'), where('shopId', '==', S.uid)), (snap) => { const c = {}; snap.docs.forEach((d) => { const v = d.data(); if (v && v.codigo) c[d.id] = v.codigo; }); S.codes = c; render(); });
  }
}
async function ensureWallet() {
  try {
    const ref = doc(db, 'wallets', S.uid);
    const s = await getDoc(ref);
    if (!s.exists()) await setDoc(ref, { saldoC: 0 });
  } catch (e) {}
}

function onMyOrders(snap) {
  const next = orderDocs(snap), act = (o) => o.estado === 'asignado' || o.estado === 'recogido';
  const was = S.myOrders.filter(act), ids = new Set(next.filter(act).map((o) => o.id));
  was.forEach((o) => {
    if (ids.has(o.id)) return;
    S.ignored.add(o.id);
    const now = next.find((x) => x.id === o.id);
    if (now && now.estado === 'cancelado') { beep([440, 330]); toast('Soporte canceló el pedido ' + folio(o.id) + '.'); }
    else if (!now) { beep([440, 330]); toast('Soporte reasignó el pedido ' + folio(o.id) + ' a otro repartidor.'); }
  });
  S.myOrders = next; mergeOrders(); syncSheet(); render();
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
  listen(unsubs, query(collection(db, 'aprobaciones'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.aprobs = m; render(); assignRepNos(); });
  listen(unsubs, query(collection(db, 'recargas'), orderBy('creadoEn', 'desc'), limit(300)), (snap) => { S.recargas = snap.docs.map((d) => d.data()).filter((r) => r && r.id && r.estado); render(); });
  listen(unsubs, query(collection(db, 'wallets'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.wallets = m; render(); });
  listen(unsubs, query(collection(db, 'movs'), orderBy('creadoEn', 'desc'), limit(1000)), (snap) => { S.movs = snap.docs.map((d) => d.data()); render(); });
  listen(unsubs, query(collection(db, 'presence'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.presence = m; render(); });
  listen(unsubs, doc(db, 'config', 'pago'), (s) => { S.pago = (s.exists() && s.data().texto) || ''; render(); });
  listen(unsubs, query(collection(db, 'incidencias'), orderBy('creadoEn', 'desc'), limit(200)), (snap) => {
    const arr = snap.docs.map((d) => d.data()).filter((x) => x && x.id && x.tipo);
    if (S.incReady) arr.forEach((x) => { if (x.estado === 'abierta' && !S.incMine.has(x.id)) { beep([880, 660, 880]); buzz(); toast('Incidencia de ' + (x.driverName || 'un repartidor') + ': ' + (INC_TIPOS[x.tipo] || x.tipo)); } });
    arr.forEach((x) => S.incMine.add(x.id));
    S.incs = arr; S.incReady = true; render();
  });
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
  const codigo = String(1000 + Math.floor(Math.random() * 9000));
  const batch = writeBatch(db);
  batch.set(doc(db, 'orders', id), Object.assign({ id, estado: 'abierto', driverId: '', driverName: '', creadoEn: Date.now() }, o));
  batch.set(doc(db, 'codes', id), { shopId: S.uid, codigo });
  await batch.commit();
  return id;
}

async function accept(id) {
  if (!canAct() || S.busy.has(id) || view() !== 'rider') return;
  if (!S.online) { toast('Conéctate para aceptar pedidos.'); return; }
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
async function delivered(id, codigoIn) {
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
      tx.update(oref, { estado: 'entregado', entregadoEn: now, codigoIn });
      tx.update(wref, { saldoC: (Number(ws.data().saldoC) || 0) - com, lastOrder: id });
      tx.set(doc(db, 'movs', 'cm_' + id), { driverId: S.uid, tipo: 'comision', montoC: -com, orderId: id, creadoEn: now });
    });
    toast('Entrega registrada. Se descontó ' + cents(comC(o)) + ' de comisión.');
  } catch (e) {
    if (e && (e.code === 'permission-denied' || /permission/i.test(e.message || ''))) { codeFail(); }
    else if (e && e.message === 'nowallet') { await ensureWallet(); toast('Se estaba abriendo tu saldo. Vuelve a tocar "Ya entregué".'); }
    else toast('No se pudo registrar la entrega. Intenta de nuevo.');
  }
  S.busy.delete(id); render();
  return true;
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
  const slots = slotsFor(S.profile);
  const have = slots.every((s) => safeImg(S.fotos[s.k]));
  if (!canAct() || !have || !S.consent || S.busy.has('verify')) return;
  if (S.role === 'rider' && !regDone()) return;
  S.busy.add('verify'); render();
  try {
    const upd = { docsEn: Date.now(), fotos: slots.map((s) => s.k) };
    if (S.role === 'rider' && !(S.profile && S.profile.reglamentoV === REG_V)) { upd.reglamentoEn = Date.now(); upd.reglamentoV = REG_V; }
    await updateDoc(doc(db, 'users', S.uid), upd);
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
function repTag(id) { const n = (S.aprobs[id] || {}).repNo; return n ? 'R-' + String(n).padStart(3, '0') + ' · ' : ''; }
function nextRepNo() { let m = 0; Object.keys(S.aprobs).forEach((k) => { const n = S.aprobs[k] && S.aprobs[k].repNo; if (n > m) m = n; }); return m + 1; }
async function assignRepNos() {
  if (!S.isAdmin || S.repBusy) return;
  const miss = S.users.filter((u) => u.role === 'rider' && S.aprobs[u.id] && S.aprobs[u.id].estado === 'aprobado' && !S.aprobs[u.id].repNo);
  if (!miss.length) return;
  S.repBusy = true;
  try {
    let n = nextRepNo();
    for (const u of miss.sort((a, b) => (a.creadoEn || 0) - (b.creadoEn || 0))) { await setDoc(doc(db, 'aprobaciones', u.id), { repNo: n }, { merge: true }); n++; }
  } catch (e) {}
  S.repBusy = false;
}
async function resolveAlta(id, ok, motivo) {
  const k = 'al' + id;
  if (!S.isAdmin || S.busy.has(k)) return;
  if (!ok && !motivo) { toast('Escribe el motivo del rechazo.'); return; }
  S.busy.add(k); render();
  try {
    const prev = S.aprobs[id] || {}, usr = S.users.find((x) => x.id === id);
    const data = { id, estado: ok ? 'aprobado' : 'rechazado', motivo: ok ? '' : motivo, en: Date.now(), por: S.uid };
    if (prev.repNo) data.repNo = prev.repNo; else if (ok && usr && usr.role === 'rider') data.repNo = nextRepNo();
    await setDoc(doc(db, 'aprobaciones', id), data);
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
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' + payNote(o) +
    '<div class="actions"><button class="btn ghost" type="button" data-act="ignore" data-id="' + esc(o.id) + '">Ignorar</button>' +
    '<button class="btn primary" type="button" data-act="accept" data-id="' + esc(o.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Aceptando…' : 'Aceptar') + '</button></div></div>';
}

/* ---------- pantallas ---------- */
const emptyBox = (title, text) => '<div class="empty"><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>';
const DSEP = ' ¦';
function pdesc(o) {
  const d = String((o && o.desc) || ''), i = d.lastIndexOf(DSEP);
  if (i < 0) return { t: d };
  const m = d.slice(i + 2).split('|');
  if (!/^[evp]$/.test(m[0] || '') || !/^[re]$/.test(m[2] || '')) return { t: d };
  return { t: d.slice(0, i), tipo: m[0], prod: Number(m[1]) || 0, quien: m[2] };
}
function payNote(o) {
  const d = pdesc(o); if (!d.tipo) return '';
  const T = pesos(o.tarifa), P = pesos(d.prod), rec = d.quien === 'r';
  let a = [];
  if (d.tipo === 'v') a.push('<b>Paga ' + P + '</b> al vendedor al recoger.');
  if (d.tipo === 'p') a.push('El producto ya está pagado: <b>no pagues ni cobres</b> el producto.');
  if (d.tipo === 'v') a.push(rec ? '<b>Cobra ' + pesos(d.prod + Number(o.tarifa)) + '</b> al entregar (' + P + ' del producto + ' + T + ' de tu mandadito).' : '<b>Cobra ' + P + '</b> al entregar. Tu mandadito (' + T + ') te lo paga quien envía.');
  else a.push(rec ? '<b>Cobra ' + T + '</b> al entregar (tu mandadito).' : 'Quien envía te paga <b>' + T + '</b> (tu mandadito). No cobres nada al entregar.');
  return '<p class="paynote">' + a.join(' ') + '</p>';
}
function sendNote(o) {
  const d = pdesc(o); if (!d.tipo) return '';
  const T = pesos(o.tarifa), P = pesos(d.prod), rec = d.quien === 'r';
  let t = '';
  if (d.tipo === 'v') t = 'El repartidor te pagará <b>' + P + '</b> al recoger. Al entregar cobrará <b>' + pesos(Number(o.cobro)) + '</b>' + (rec ? ' (' + P + ' del producto + ' + T + ' del mandadito).' : ' (el producto). Tú pagas el mandadito (' + T + ').');
  else if (d.tipo === 'p') t = 'El producto ya está pagado.' + (rec ? ' Quien recibe pagará ' + T + ' del mandadito.' : ' Tú pagas el mandadito (' + T + ') al repartidor.');
  else t = rec ? 'Quien recibe pagará ' + T + ' del mandadito.' : 'Tú pagas el mandadito (' + T + ') al repartidor.';
  return '<p class="paynote">' + t + '</p>';
}
function orderLines(o) {
  return '<div class="line"><span class="k">Cliente</span><span class="v">' + esc(o.cliente) + '</span></div>' +
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' +
    '<div class="line"><span class="k">Lleva</span><span class="v">' + esc(pdesc(o).t) + '</span></div>';
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
  const el = $('#viewVerify'), st = myStatus(), slots = slotsFor(S.profile);
  const headH = '<h1>Verifica tu cuenta</h1>';
  if (st === 'revision' && !S.verEdit) {
    el.innerHTML = headH + '<div class="empty"><b>Tus documentos están en revisión</b><span>La administración los revisa. Esta pantalla se actualiza sola cuando te aprueben.</span></div>' +
      '<button class="btn ghost block" type="button" data-act="ver-edit">Cambiar mis documentos</button>';
    return;
  }
  const a = S.myAprob;
  let h = headH + '<p class="lede">' + (S.role === 'rider' ? 'Para recibir pedidos necesitamos 6 fotos. Solo sirven para confirmar quién eres.' : isCli(S.profile) ? 'Para pedir mandaditos necesitamos 3 fotos: tu selfie y tu INE por los dos lados. Solo sirven para confirmar quién eres.' : 'Para pedir motos necesitamos 3 fotos. Solo sirven para confirmar tu negocio.') + '</p>';
  if (st === 'rechazado') h += '<div class="banner"><b>No se aprobaron tus documentos.</b> ' + esc(a && a.motivo ? a.motivo : 'Revisa las fotos y súbelas de nuevo.') + '</div>';
  let ready = 0;
  slots.forEach((s) => {
    const im = safeImg(S.fotos[s.k]), up = !!S.uploading[s.k];
    if (im) ready++;
    h += '<div class="slot"><div class="t"><b>' + esc(s.t) + '</b>' + (up ? '<span class="chip abierto">Subiendo…</span>' : (im ? '<span class="chip entregado">Lista</span>' : '<span class="chip">Falta</span>')) + '</div>' +
      '<p class="hint">' + esc(s.h) + '</p>' + (im ? '<img class="thumb" src="' + im + '" alt="' + esc(s.t) + '">' : '') +
      '<input class="sr" type="file" accept="image/*"' + (s.selfie ? ' capture="user"' : '') + ' id="f-' + s.k + '" data-foto="' + s.k + '"' + (up ? ' disabled' : '') + '>' +
      '<label class="btn ' + (im ? 'ghost' : 'primary') + ' small" for="f-' + s.k + '">' + (im ? 'Cambiar foto' : 'Tomar o subir foto') + '</label></div>';
  });
  const all = ready === slots.length, sending = S.busy.has('verify');
  if (S.role === 'rider') {
    const done = regDone();
    h += '<h2 class="section">Reglamento y aviso de privacidad</h2><p class="hint">Léelo completo hasta el final para poder aceptarlo.</p>' +
      '<div class="reg" id="regBox" tabindex="0">' + regHtml() + '</div>' +
      '<label class="check"><input type="checkbox" id="v-reg"' + (done ? ' checked' : '') + (S.regRead || done ? '' : ' disabled') + '><span>' + esc(REG_CONST) + '</span></label>' +
      (S.regRead || done ? '' : '<p class="hint">Baja hasta el final del texto para activar esta casilla.</p>');
  }
  h += '<label class="check"><input type="checkbox" id="v-consent"' + (S.consent ? ' checked' : '') + '><span>Acepto que la administración use estas fotos solo para verificar mi identidad y mi negocio.</span></label>' +
    '<button class="btn primary block" type="button" data-act="ver-send"' + (all && S.consent && !sending && (S.role !== 'rider' || regDone()) ? '' : ' disabled') + '>' + (sending ? 'Enviando…' : 'Enviar a revisión') + '</button>' +
    (all ? '' : '<p class="hint">Sube las ' + slots.length + ' fotos para poder enviar.</p>');
  el.innerHTML = h;
  const rb = document.getElementById('regBox'); if (rb) rb.scrollTop = S.regTop || 0;
}

function shopCard(o) {
  let s = '';
  if (o.estado === 'abierto') s = '<div class="status"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>Buscando repartidor</div>';
  else if (o.estado === 'asignado') s = '<div class="status"><b>' + esc(o.driverName || 'Un repartidor') + '</b> va por el pedido · ' + ago(o.asignadoEn || o.creadoEn) + '</div>';
  else if (o.estado === 'recogido') s = '<div class="status"><b>' + esc(o.driverName || 'El repartidor') + '</b> ya salió con el pedido</div>';
  const cod = S.codes[o.id];
  if (cod && (o.estado === 'abierto' || o.estado === 'asignado' || o.estado === 'recogido')) {
    const wa = waUrl(o.tel);
    s += '<div class="codebox"><small>Código de entrega · dáselo a tu cliente</small><b>' + esc(cod) + '</b><span>El repartidor lo necesita para terminar la entrega.</span>' +
      (wa ? '<a class="btn ghost small" target="_blank" rel="noopener" href="' + esc(wa + '?text=' + encodeURIComponent('Tu código de entrega es ' + cod + '. Dáselo al repartidor cuando llegue.')) + '">Enviar por WhatsApp</a>' : '') + '</div>';
  }
  if (o.estado === 'entregado') s = '<div class="status">Entregado por <b>' + esc(o.driverName || 'el repartidor') + '</b></div>';
  let act = '';
  if (o.estado === 'abierto') {
    act = S.cancelId === o.id
      ? '<div class="actions"><button class="btn ghost small" type="button" data-act="cancel-no">Conservar</button><button class="btn danger small" type="button" data-act="cancel-yes" data-id="' + esc(o.id) + '">Sí, cancelar</button></div>'
      : '<div class="actions"><button class="btn ghost small" type="button" data-act="cancel" data-id="' + esc(o.id) + '"' + (S.busy.has(o.id) ? ' disabled' : '') + '>Cancelar pedido</button></div>';
  }
  return '<article class="order">' + head(o) + orderLines(o) + moneyRow(o) + sendNote(o) + s + act + '</article>';
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
  { const cli = isCli(S.profile); $('#cliPay').hidden = !cli; $('#cliQuien').hidden = !cli; $('#fProd').hidden = !cli; $('#paySum').hidden = !cli; $('#o-cobro').closest('.field').hidden = cli; $('#orderForm .pair').style.gridTemplateColumns = cli ? '1fr' : '';
    $('label[for=o-tarifa]').textContent = cli ? 'Oferta por el mandadito' : 'Pago al repartidor'; $('#o-tarifa').placeholder = cli ? '$ cuánto ofreces pagar por el mandadito' : '$ envío';
    $('label[for=o-desc]').textContent = cli ? '¿Qué vas a enviar?' : 'Qué se entrega'; $('#o-desc').placeholder = cli ? 'Ej. Un martillo, zapatos escolares' : 'Ej. 2 pizzas grandes y 1 refresco'; }
  { const cli = isCli(S.profile), pk = $('#o-pick'), box = pk.closest('.field'), pf = $('#pickFields');
    if (box) box.hidden = cli; pk.required = !cli;
    if (pf) { pf.hidden = !cli; ['p-calle', 'p-col', 'p-ciudad', 'p-mun'].forEach((i) => { $('#' + i).required = cli; }); } }
  if (!isCli(S.profile) && !$('#o-pick').value && S.addr && document.activeElement !== $('#o-pick')) $('#o-pick').value = S.addr;
  return [{ id: 'nuevo', label: 'Nuevo pedido' }, { id: 'pedidos', label: 'Mis pedidos', badge: active.length }];
}

function acceptBtn(o, busy) {
  if (!S.walletReady || !S.wallet) return '<button class="btn ghost" type="button" disabled>Cargando saldo…</button>';
  if (!S.online) return '<button class="btn ghost" type="button" data-act="online">Conéctate para aceptar pedidos</button>';
  if (!canTake(o)) return '<button class="btn ghost" type="button" data-act="tab" data-tab="saldo">Saldo insuficiente · Recargar</button>';
  return '<button class="btn primary" type="button" data-act="accept" data-id="' + esc(o.id) + '"' + (busy || !canAct() ? ' disabled' : '') + '>' + (busy ? 'Aceptando…' : 'Aceptar pedido') + '</button>';
}
function availCard(o) {
  return '<article class="order">' + head(o) +
    '<div class="line"><span class="k">Recoger en</span><span class="v">' + esc(o.shop) + ' · ' + esc(o.pickup) + '</span></div>' +
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' +
    '<div class="line"><span class="k">Lleva</span><span class="v">' + esc(pdesc(o).t) + '</span></div>' +
    moneyRow(o) + payNote(o) +
    '<p class="hint">Comisión de ' + cents(comC(o)) + ' (13%) al entregar.</p>' +
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
    moneyRow(o) + payNote(o) + links + '<div class="actions">' + btn + '</div>' +
    '<button class="btn ghost small block" type="button" data-act="issue" data-id="' + esc(o.id) + '">Tengo un problema</button></article>';
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
    '<p class="hint">Cada envío entregado descuenta el 13% de su pago. Sin saldo suficiente no puedes aceptar pedidos nuevos.</p>' +
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
    return { rank, html: prRow(repTag(u.id) + u.name, st, cls, 'Saldo ' + sal + ' · ' + hoy + ' entregas hoy · ' + (last ? 'última actividad ' + ago(last) : 'sin viajes todavía') + ' · se unió ' + ago(u.creadoEn)) };
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
  const slots = slotsFor(u), open = S.review === u.id, busy = S.busy.has('al' + u.id);
  const n = Array.isArray(u.fotos) ? u.fotos.length : 0;
  let h = '<article class="order"><div class="head"><span class="folio">' + esc(u.name) + '</span><span class="chip abierto">' + esc(roleLbl(u)) + '</span><span class="ago">' + ago(u.docsEn) + '</span></div>' +
    (u.role === 'shop' && u.addr ? '<div class="line"><span class="k">Dirección</span><span class="v">' + esc(u.addr) + '</span></div>' : '') +
    '<div class="line"><span class="k">Fotos enviadas</span><span class="v">' + n + ' de ' + slots.length + '</span></div>' +
    (u.role === 'rider' ? '<div class="line"><span class="k">Reglamento</span><span class="v">' + (u.reglamentoEn ? 'Aceptado v' + esc(u.reglamentoV || '') + ' · ' + new Date(u.reglamentoEn).toLocaleString('es-MX') : 'No lo ha aceptado') + '</span></div>' : '');
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
    return '<div class="pr"><div class="t"><b>' + esc(repTag(u.id) + u.name) + '</b><span class="chip entregado">Aprobado</span></div><small>' + esc(roleLbl(u)) + ' · aprobado ' + ago(a.en || u.creadoEn) + '</small>' +
      (S.suspId === u.id
        ? '<div class="actions"><button class="btn ghost small" type="button" data-act="susp-no">Conservar</button><button class="btn danger small" type="button" data-act="susp-yes" data-id="' + esc(u.id) + '">Sí, suspender</button></div>'
        : '<div class="actions"><button class="btn ghost small" type="button" data-act="susp" data-id="' + esc(u.id) + '">Suspender</button></div>') + '</div>';
  }).join('') : '<p class="hint">Todavía no has aprobado a nadie.</p>';
  if (oth.length) {
    h += '<div class="subhead">Sin enviar o rechazados (' + oth.length + ')</div>' + oth.map((x) => {
      const a = S.aprobs[x.u.id];
      return prRow(x.u.name, verLabel(x.st), '', esc(roleLbl(x.u)) + (x.st === 'rechazado' && a && a.motivo ? ' · ' + esc(a.motivo) : '') + ' · se unió ' + ago(x.u.creadoEn));
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
  const ic = incDiv(); ic.hidden = S.tab !== 'incidencias';
  if (S.tab === 'incidencias') renderIncid(ic);
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
    { id: 'incidencias', label: 'Incidencias', badge: S.incs.filter((x) => x.estado === 'abierta').length },
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
  try { const on = $('#tabsIn').querySelector('[aria-selected="true"]'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) {}
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
  if (S.user) who.textContent = v === 'admin' ? 'Dueño' : (S.name ? (isCli(S.profile) ? 'Servicio de mandadito · ' : { shop: 'Tienda · ', rider: 'Repartidor · ' }[S.role] || '') + (S.role === 'rider' && S.myAprob && S.myAprob.repNo ? 'R-' + String(S.myAprob.repNo).padStart(3, '0') + ' · ' : '') + S.name : 'Salir');
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
  let cobro = Math.round((Number($('#o-cobro').value) || 0) * 100) / 100, descTxt = $('#o-desc').value.trim();
  if (isCli(S.profile)) {
    const tp = (document.querySelector('input[name=ctipo]:checked') || {}).value || 'e', qp = (document.querySelector('input[name=cquien]:checked') || {}).value || 'r';
    const prod = tp === 'v' ? Math.round((Number($('#o-prod').value) || 0) * 100) / 100 : 0;
    if (tp === 'v' && prod <= 0) { toast('Escribe cuánto cuesta el producto.'); btn.disabled = false; btn.textContent = 'Pedir moto'; return; }
    cobro = Math.round((prod + (qp === 'r' ? tarifa : 0)) * 100) / 100;
    descTxt = descTxt.slice(0, 90) + DSEP + tp + '|' + prod + '|' + qp;
  }
  const o = {
    shopId: S.uid, shop: S.name, pickup: isCli(S.profile) ? buildPick() : $('#o-pick').value.trim(), cliente: $('#o-cliente').value.trim(), tel: $('#o-tel').value.trim(),
    dest: buildDest(), desc: descTxt, cobro, tarifa
  };
  try {
    if (tarifa < 1 || tarifa > 2000) throw new Error('tarifa');
    const id = await createOrder(o);
    ['o-cliente', 'o-tel', 'o-dest', 'o-calle', 'o-num', 'o-int', 'o-col', 'o-ref', 'o-desc', 'o-cobro'].forEach((i) => { $('#' + i).value = ''; });
    ['p-calle', 'p-col', 'o-prod'].forEach((i) => { $('#' + i).value = ''; }); cliSum();
    saveCity();
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
  if (monto < 50 || monto > 5000) { toast('La recarga debe ser de $50 a $5,000.'); return; }
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
  else if (t.id === 'v-reg') { S.regOk = t.checked; render(); }
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
  else if (act === 'delivered') askCode(id);
  else if (act === 'issue') askIssue(id);
  else if (act === 'inc-ok') incDone(id);
  else if (act === 'inc-reopen') incReopen(id, b.getAttribute('data-oid'));
  else if (act === 'inc-cancel') incCancel(id, b.getAttribute('data-oid'));
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

/* Instalar con un toque: en Android muestra un botón "Instalar Gasca" en la pantalla de entrada. */
(function () {
  const hint = document.getElementById('installHint');
  if (!hint) return;
  if ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone) { hint.hidden = true; return; }
  let ev = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); ev = e;
    hint.innerHTML = '<b>Instala Gasca en tu celular</b><button class="btn primary block" type="button" id="installBtn">Instalar Gasca</button>';
    const b = document.getElementById('installBtn');
    if (b) b.addEventListener('click', async () => { try { ev.prompt(); await ev.userChoice; } catch (_) {} ev = null; hint.hidden = true; });
  });
  window.addEventListener('appinstalled', () => { hint.hidden = true; });
})();

/* Actualización automática: si hay una versión nueva, la app se recarga sola cuando no estorba. */
(function () {
  let base = null, pending = false, warned = false;
  const hash = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return h + ':' + t.length; };
  const fetchHash = async (fresh) => {
    const r = await fetch(import.meta.url.split('?')[0], fresh ? { cache: 'no-store' } : undefined);
    if (!r.ok) throw new Error('x');
    return hash(await r.text());
  };
  const busyNow = () => {
    try {
      if (S.role === 'rider' && mine().some((o) => o.estado === 'asignado' || o.estado === 'recogido')) return true;
      if (Object.keys(S.uploading || {}).length) return true;
      if (S.sheetId) return true;
      if (S.busy && S.busy.size) return true;
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    } catch (_) { return true; }
    return false;
  };
  const tryReload = () => {
    if (!pending) return;
    if (busyNow()) {
      if (!warned) { warned = true; try { toast('Hay una versión nueva. Se actualiza al terminar lo que haces.'); } catch (_) {} }
      return;
    }
    location.reload();
  };
  const check = async () => {
    if (!navigator.onLine || document.hidden) return;
    try {
      if (base === null) { base = await fetchHash(false); return; }
      if (pending) { tryReload(); return; }
      const now = await fetchHash(true);
      if (now !== base) { pending = true; tryReload(); }
    } catch (_) { /* sin red: se intenta luego */ }
  };
  setTimeout(check, 4000);
  setInterval(check, 5 * 60 * 1000);
  setInterval(() => { if (pending) tryReload(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('online', check);
})();

/* Colores de la ficha de depósito: siguen el tema claro/oscuro. */
(function () {
  const s = document.createElement('style');
  s.textContent = '.ficha{background:var(--surface);color:var(--ink);border-color:var(--line)}' +
    '.ficha .k{color:var(--muted)}.ficha .amt,.ficha .num,.ficha .v{color:var(--ink)}.ficha .num{font-size:24px}';
  document.head.appendChild(s);
})();


/* ---------- código de entrega (anti-estafas) ---------- */
(function () {
  const st = document.createElement('style');
  st.textContent = '.codebox{margin:10px 0;padding:12px;border:2px dashed var(--line);border-radius:12px;text-align:center;background:var(--surface);color:var(--ink)}' +
    '.codebox b{display:block;font-size:34px;letter-spacing:8px;margin:4px 0}.codebox small,.codebox span{display:block;color:var(--muted);font-size:13px}.codebox .btn{margin-top:8px}' +
    '#codeModal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}' +
    '#codeModal .box{background:var(--surface);color:var(--ink);border-radius:16px;padding:20px;width:100%;max-width:340px;text-align:center}' +
    '#codeModal input{width:100%;font-size:32px;text-align:center;letter-spacing:10px;padding:10px;margin:12px 0;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);box-sizing:border-box}' +
    '#codeModal .err{color:#d33;min-height:20px;font-size:14px}#codeModal .btn{width:100%;margin-top:8px}';
  document.head.appendChild(st);
})();
let codeTries = 0, codeLock = 0, codeId = null;
function closeCode() { const m = document.getElementById('codeModal'); if (m) m.remove(); codeId = null; }
function codeFail() {
  codeTries++;
  const e = document.querySelector('#codeModal .err');
  if (codeTries >= 3) { codeLock = Date.now() + 60000; codeTries = 0; }
  if (e) e.textContent = Date.now() < codeLock ? 'Demasiados intentos. Espera 1 minuto.' : 'Código incorrecto. Pídeselo al cliente.';
  const i = document.getElementById('codeIn'); if (i) { i.value = ''; i.focus(); }
}
function askCode(id) {
  const o = byId(id);
  if (!canAct() || !o || o.estado !== 'recogido' || document.getElementById('codeModal')) return;
  codeId = id;
  const m = document.createElement('div'); m.id = 'codeModal';
  m.innerHTML = '<div class="box"><h3>Código de entrega</h3><p>Pídele al cliente el código de 4 números que le dio el negocio.</p>' +
    '<input id="codeIn" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="----"><div class="err"></div>' +
    '<button class="btn primary" type="button" id="codeOk">Confirmar entrega</button><button class="btn ghost" type="button" id="codeNo">Cancelar</button></div>';
  document.body.appendChild(m);
  const inp = document.getElementById('codeIn'); inp.focus();
  inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); });
  document.getElementById('codeNo').addEventListener('click', closeCode);
  document.getElementById('codeOk').addEventListener('click', async () => {
    const v = inp.value;
    const err = m.querySelector('.err');
    if (Date.now() < codeLock) { err.textContent = 'Demasiados intentos. Espera 1 minuto.'; return; }
    if (v.length !== 4) { err.textContent = 'Escribe los 4 números.'; return; }
    const okBtn = document.getElementById('codeOk'); okBtn.disabled = true;
    await delivered(id, v);
    const cur = byId(id);
    if (cur && cur.estado === 'entregado') closeCode(); else if (okBtn.isConnected) okBtn.disabled = false;
  });
}


/* ---------- reglamento para repartidores ---------- */
const REG_V = '1.1';
const REG_TEXT = "GASCA\n\nREGLAMENTO OPERATIVO PARA REPARTIDORES\n\nVersión: 1.1\nLugar de aplicación: Tepic, Nayarit, México\nFecha de entrada en vigor: 19 de octubre de 2026\n\nCAPÍTULO I. DISPOSICIONES GENERALES\n\nArtículo 1. Objeto\n\nEl presente reglamento establece las condiciones de operación, obligaciones, responsabilidades y medidas de seguridad aplicables a los repartidores que prestan servicios mediante la plataforma GASCA.\n\nSu finalidad es garantizar una operación organizada, segura y transparente, así como proteger los intereses de los clientes, repartidores y demás participantes.\n\nLas disposiciones deberán interpretarse y aplicarse conforme a la legislación vigente y a la naturaleza jurídica de la relación correspondiente.\n\nArtículo 2. Requisitos de registro\n\nPara registrarse y operar en GASCA, el repartidor deberá:\n\n1. Ser mayor de edad.\n2. Proporcionar información personal verdadera y actualizada.\n3. Presentar identificación oficial vigente.\n4. Contar con un número telefónico activo.\n5. Presentar licencia de conducir y documentación vehicular cuando corresponda.\n6. Cumplir los requisitos de seguridad aplicables.\n7. Conocer y aceptar las condiciones operativas.\n8. Tener una cuenta individual autorizada.\n\nCAPÍTULO II. MONEDERO DIGITAL Y COMISIONES\n\nArtículo 3. Monedero GASCA\n\nCada repartidor contará con un monedero digital dentro de la aplicación GASCA, mediante el cual se administrará su saldo operativo.\n\nEste saldo se utilizará para cubrir las comisiones que correspondan a los servicios de envío realizados.\n\nEl monedero permitirá consultar recargas, comisiones, reservas, devoluciones y ajustes.\n\nArtículo 4. Comisión por servicio\n\nGASCA cobrará una comisión equivalente al 13% del costo de cada envío completado.\n\nLa comisión se calculará exclusivamente sobre el costo del servicio de envío y no sobre el valor de mercancías o productos transportados.\n\nEl porcentaje aplicable deberá informarse antes de aceptar el servicio.\n\nArtículo 5. Saldo suficiente\n\nPara aceptar un pedido, el repartidor deberá contar con saldo disponible suficiente para cubrir la comisión correspondiente.\n\nSi el saldo resulta insuficiente, la aplicación impedirá aceptar nuevos pedidos hasta que se realice una recarga.\n\nLa falta de saldo no cancelará automáticamente los pedidos previamente aceptados.\n\nArtículo 6. Descuento de comisiones\n\nAl aceptar un pedido, GASCA podrá reservar temporalmente la comisión estimada.\n\nUna vez confirmada la entrega, la comisión se descontará definitivamente del saldo del repartidor.\n\nSi el pedido se cancela sin que corresponda un cargo previamente informado y legalmente procedente, la reserva será liberada.\n\nNo podrá realizarse un doble cobro por el mismo servicio.\n\nArtículo 7. Recargas y aclaraciones\n\nLas recargas deberán realizarse mediante los métodos autorizados por GASCA.\n\nCada operación deberá contar con un registro que permita identificar su fecha, importe y referencia.\n\nEl repartidor podrá solicitar la revisión de movimientos incorrectos y conocer las condiciones aplicables a la devolución de saldos.\n\nCAPÍTULO III. COBROS EN EFECTIVO\n\nArtículo 8. Forma de pago\n\nTodos los pagos de los servicios de envío se realizarán en efectivo directamente al repartidor.\n\nEl repartidor recibirá el importe completo autorizado por el servicio, mientras que la comisión correspondiente a GASCA será descontada del saldo de su monedero digital.\n\nArtículo 9. Manejo del efectivo\n\nEl repartidor deberá:\n\n1. Cobrar únicamente los importes autorizados.\n2. Registrar correctamente la recepción del pago.\n3. No modificar unilateralmente el costo del envío.\n4. Entregar al destinatario los productos conforme a las instrucciones del servicio.\n5. Reportar cualquier diferencia o incidencia en los cobros.\n\nCuando un pedido incluya dinero correspondiente al valor de mercancías o pagos por cuenta de terceros, dichos importes deberán identificarse por separado y entregarse a quien corresponda.\n\nArtículo 10. Prohibición de cobros adicionales\n\nQueda prohibido exigir propinas obligatorias, cargos no autorizados o cantidades adicionales a las informadas al cliente.\n\nLas propinas voluntarias no formarán parte de la base de cálculo de la comisión de GASCA, salvo acuerdo válido y expresamente informado.\n\nCAPÍTULO IV. OPERACIÓN DE LOS SERVICIOS\n\nArtículo 11. Disponibilidad\n\nPara recibir pedidos, el repartidor deberá:\n\n1. Mantener su cuenta autorizada.\n2. Contar con saldo suficiente.\n3. Estar disponible para trabajar.\n4. Cumplir los requisitos de documentación y seguridad.\n5. No tener una restricción operativa vigente.\n\nArtículo 12. Zonas de servicio\n\nLos repartidores podrán recibir servicios dentro de las zonas autorizadas por GASCA.\n\nLa asignación dependerá de la cobertura, disponibilidad y condiciones del pedido.\n\nArtículo 13. Aceptación de pedidos\n\nAl aceptar un servicio, el repartidor deberá cumplir las condiciones informadas, salvo que exista una causa justificada para cancelarlo o suspenderlo.\n\nNo podrá transferir un pedido a otra persona sin autorización.\n\nArtículo 14. Pedidos simultáneos\n\nEl repartidor no podrá exceder el límite de pedidos activos establecido por GASCA.\n\nEste límite deberá comunicarse antes de su aplicación.\n\nArtículo 15. Recolección y entrega\n\nEl repartidor deberá:\n\n1. Acudir al punto de recolección.\n2. Verificar los datos del servicio.\n3. Transportar el paquete de forma segura.\n4. Mantener actualizado el estado del pedido.\n5. Entregarlo a la persona autorizada.\n6. Registrar la evidencia correspondiente.\n\nArtículo 16. Comprobante de entrega\n\nGASCA podrá requerir un código de confirmación, comprobante electrónico, fotografía permitida u otro mecanismo de validación.\n\nNo podrá registrarse una entrega como completada sin la confirmación correspondiente.\n\nArtículo 17. Cancelaciones\n\nLas cancelaciones deberán registrarse mediante los canales oficiales.\n\nSe considerarán circunstancias justificadas los riesgos de seguridad, emergencias, fallas mecánicas, direcciones incorrectas y otras causas razonables.\n\nLas cancelaciones injustificadas reiteradas podrán revisarse administrativamente, sin imponer sanciones por el ejercicio legítimo de derechos.\n\nCAPÍTULO V. SEGURIDAD Y CONDUCTA\n\nArtículo 18. Seguridad vial\n\nEl repartidor deberá respetar las normas de tránsito, utilizar el equipo de protección correspondiente y mantener su vehículo en condiciones seguras.\n\nQueda prohibido conducir bajo los efectos del alcohol o sustancias que afecten la capacidad de conducción.\n\nArtículo 19. Protección de mercancías\n\nQueda prohibido abrir, sustraer, utilizar, alterar o retener injustificadamente los paquetes transportados.\n\nCualquier daño, pérdida o incidencia deberá reportarse oportunamente.\n\nArtículo 20. Conducta profesional\n\nEl repartidor deberá mantener un trato respetuoso hacia clientes, comercios y personal de GASCA.\n\nNo se permitirán amenazas, agresiones, acoso, discriminación ni actos fraudulentos.\n\nArtículo 21. Confidencialidad\n\nLos datos de clientes, direcciones, teléfonos y detalles de los pedidos únicamente podrán utilizarse para realizar los servicios autorizados.\n\nQueda prohibida su divulgación o utilización para fines personales.\n\nArtículo 22. Uso de la cuenta\n\nLa cuenta de repartidor será personal.\n\nQueda prohibido compartir contraseñas, prestar la cuenta o suplantar la identidad de otra persona.\n\nCAPÍTULO VI. RESTRICCIONES Y MEDIDAS ADMINISTRATIVAS\n\nArtículo 23. Restricciones operativas\n\nGASCA podrá impedir nuevas asignaciones cuando:\n\n1. El saldo sea insuficiente para cubrir la comisión del pedido.\n2. La documentación obligatoria esté vencida.\n3. La cuenta se encuentre suspendida.\n4. El repartidor no esté disponible.\n5. Se haya alcanzado el máximo de pedidos simultáneos.\n6. Exista una situación de seguridad que justifique una restricción preventiva.\n\nLas restricciones deberán ser proporcionales y estar sujetas a los mecanismos de revisión correspondientes.\n\nArtículo 24. Medidas disciplinarias\n\nAnte incumplimientos acreditados podrán aplicarse, según su gravedad:\n\n1. Advertencia documentada.\n2. Restricción temporal de nuevas asignaciones.\n3. Suspensión preventiva durante una investigación.\n4. Terminación del acceso a la plataforma, cuando exista causa justificada.\n\nSe deberá permitir al repartidor presentar aclaraciones y pruebas.\n\nArtículo 25. Aclaraciones\n\nLos repartidores podrán solicitar revisión de cobros, comisiones, bloqueos, cancelaciones y reportes.\n\nGASCA establecerá un canal oficial para recibir y resolver dichas solicitudes.\n\nArtículo 26. Modificaciones\n\nGASCA podrá actualizar el reglamento, comunicando oportunamente las modificaciones.\n\nNinguna disposición podrá utilizarse para limitar derechos reconocidos por la legislación aplicable.\n\n---\n\nGASCA\n\nAVISO DE PRIVACIDAD INTEGRAL PARA REPARTIDORES\n\nÚltima actualización: 19 de octubre de 2026\n\n1. Identidad y domicilio del responsable\n\nCruz Aguirre Martínez, que opera comercialmente bajo la denominación GASCA, con domicilio en calle Nudo 722, fraccionamiento Altavela, C.P. 63735, San Clemente de Lima, Nayarit, México, es responsable del tratamiento y protección de los datos personales de los repartidores.\n\nCorreo electrónico de privacidad: aguirremartinezcruzz@gmail.com\n\n2. Datos personales que se recaban\n\nGASCA podrá recopilar, según las funciones efectivamente utilizadas:\n\n- Nombre completo.\n- Número telefónico y correo electrónico.\n- Domicilio.\n- Fotografía de perfil.\n- Identificación oficial.\n- Licencia de conducir.\n- Documentación del vehículo.\n- Datos necesarios para recargas, pagos y conciliaciones.\n- Saldo operativo e historial de movimientos.\n- Historial de pedidos y entregas.\n- Ubicación geográfica durante servicios autorizados.\n- Reportes e incidencias operativas.\n\nGASCA no solicitará datos personales sensibles salvo que exista una finalidad legítima y se cumplan los requisitos legales correspondientes.\n\n3. Finalidades del tratamiento\n\nLos datos personales serán utilizados para:\n\n1. Registrar e identificar repartidores.\n2. Verificar requisitos de incorporación.\n3. Administrar cuentas y accesos.\n4. Gestionar el monedero digital.\n5. Registrar recargas y comisiones.\n6. Verificar saldos disponibles.\n7. Asignar y supervisar servicios de entrega.\n8. Facilitar la comunicación operativa.\n9. Confirmar entregas.\n10. Atender incidencias y reclamaciones.\n11. Prevenir fraudes y accesos no autorizados.\n12. Cumplir obligaciones legales.\n\nCualquier finalidad secundaria, como el envío de publicidad no necesaria para la operación, será informada por separado y contará con los mecanismos de oposición correspondientes.\n\n4. Tratamiento de la ubicación geográfica\n\nCuando esta función esté habilitada, GASCA podrá utilizar la ubicación del repartidor para asignar servicios, facilitar rutas, verificar entregas y atender incidentes.\n\nLa geolocalización se limitará a las condiciones informadas y a los periodos necesarios para la operación.\n\nNo se realizará seguimiento permanente fuera de las condiciones autorizadas.\n\n5. Uso y comunicación de datos\n\nGASCA podrá comunicar a clientes y comercios la información estrictamente necesaria para coordinar entregas.\n\nAsimismo, podrá utilizar proveedores tecnológicos para administrar la plataforma, procesar comunicaciones y almacenar información, bajo las obligaciones de confidencialidad y seguridad correspondientes.\n\nCuando una transferencia de datos requiera consentimiento conforme a la legislación aplicable, este será solicitado previamente.\n\nGASCA no venderá los datos personales de los repartidores.\n\n6. Seguridad de la información\n\nGASCA implementará medidas administrativas, técnicas y físicas razonables para proteger los datos contra pérdida, alteración, acceso no autorizado y divulgación indebida.\n\nEl acceso estará limitado a personas y sistemas autorizados.\n\n7. Conservación de datos\n\nLos datos personales se conservarán durante el tiempo necesario para cumplir las finalidades informadas y las obligaciones legales aplicables.\n\nUna vez concluido dicho periodo, serán eliminados, bloqueados o anonimizados según corresponda.\n\n8. Derechos ARCO\n\nEl titular podrá ejercer sus derechos de acceso, rectificación, cancelación y oposición.\n\nPara ello deberá presentar una solicitud a:\n\naguirremartinezcruzz@gmail.com\n\nLa solicitud deberá contener su nombre, medio para recibir respuesta, descripción del derecho que desea ejercer y elementos necesarios para acreditar su identidad.\n\nGASCA responderá dentro de los plazos legales aplicables.\n\n9. Revocación del consentimiento\n\nCuando legalmente proceda, el repartidor podrá solicitar la revocación del consentimiento otorgado para el tratamiento de sus datos personales.\n\nLa revocación no tendrá efectos retroactivos y estará sujeta a las obligaciones legales correspondientes.\n\n10. Limitación del uso o divulgación\n\nEl titular podrá solicitar la limitación del uso o divulgación de sus datos mediante el correo de privacidad indicado.\n\n11. Modificaciones al aviso\n\nCualquier modificación al presente aviso será comunicada a través de la aplicación GASCA.\n\nLa versión vigente estará disponible para consulta.";
const REG_CONST = "Declaro que he recibido o tenido acceso al Reglamento Operativo para Repartidores GASCA y al Aviso de Privacidad Integral.\n\nReconozco que he tenido oportunidad de leer ambos documentos y solicitar aclaraciones.";
function regDone() { return !!(S.regOk || (S.profile && S.profile.reglamentoV === REG_V)); }
function regHtml() {
  return REG_TEXT.split('\n').map((l) => {
    const t = l.trim(); if (!t) return '<br>';
    if (t === '---') return '<hr>';
    const head = /^(CAPÍTULO|Artículo)/.test(t) || (t === t.toUpperCase() && /[A-ZÁÉÍÓÚ]{3}/.test(t) && !/^\d/.test(t));
    return head ? '<p><b>' + esc(t) + '</b></p>' : '<p>' + esc(t) + '</p>';
  }).join('');
}
document.addEventListener('scroll', (e) => {
  const t = e.target; if (!t || t.id !== 'regBox') return;
  S.regTop = t.scrollTop;
  if (!S.regRead && t.scrollTop + t.clientHeight >= t.scrollHeight - 8) { S.regRead = true; render(); }
}, true);
(function () {
  const st = document.createElement('style');
  st.textContent = '.reg{max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:12px;padding:12px;margin:8px 0;background:var(--surface);color:var(--ink);font-size:14px;line-height:1.45;-webkit-overflow-scrolling:touch}.reg p{margin:0 0 6px}.reg hr{border:0;border-top:1px solid var(--line);margin:12px 0}';
  document.head.appendChild(st);
})();


/* ---------- soporte e incidencias ---------- */
const SUPPORT_TEL = '8139585921';
const INC_TIPOS = { accidente: 'Tuve un accidente', danado: 'Se dañó o se cayó el pedido', moto: 'Falla de la moto', llegar: 'No puedo llegar', otro: 'Otro problema' };
function supportUrl(msg) { return waUrl(SUPPORT_TEL) + '?text=' + encodeURIComponent(msg); }
(function () {
  const st = document.createElement('style');
  st.textContent = '#issueModal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;z-index:9999;padding:12px}' +
    '#issueModal .box{background:var(--surface);color:var(--ink);border-radius:16px;padding:18px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto}' +
    '#issueModal h3{margin:0 0 8px}#issueModal .opt{display:block;width:100%;text-align:left;margin:6px 0;padding:12px;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font-size:16px}' +
    '#issueModal .opt.on{border-color:#1a73e8;font-weight:700}#issueModal textarea{width:100%;box-sizing:border-box;min-height:70px;margin:8px 0;padding:10px;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font-size:16px}' +
    '#issueModal .btn{width:100%;margin-top:8px;display:block;text-align:center;box-sizing:border-box}#issueModal .sos{background:#d33;color:#fff;font-size:20px;padding:16px}' +
    '.inc-note{margin:6px 0;font-size:14px}';
  document.head.appendChild(st);
})();
function closeIssue() { const m = document.getElementById('issueModal'); if (m) m.remove(); }
function askIssue(id) {
  const o = byId(id);
  if (!canAct() || !o || o.driverId !== S.uid || document.getElementById('issueModal')) return;
  let tipo = '';
  const m = document.createElement('div'); m.id = 'issueModal';
  document.body.appendChild(m);
  const draw = (sent) => {
    const keep = m.querySelector('textarea') ? m.querySelector('textarea').value : '';
    if (sent) {
      const msg = 'Hola, soy ' + (S.name || 'repartidor') + ' de Gasca. Pedido ' + folio(id) + ': ' + INC_TIPOS[tipo] + '.' + (sent.nota ? ' ' + sent.nota : '');
      m.innerHTML = '<div class="box"><h3>Listo, avisamos a soporte</h3><p>Tu reporte quedó registrado. Para que te atiendan más rápido, escríbenos por WhatsApp.</p>' +
        '<a class="btn primary" target="_blank" rel="noopener" href="' + esc(supportUrl(msg)) + '">Escribir a soporte por WhatsApp</a>' +
        (tipo === 'accidente' ? '<a class="btn sos" href="tel:911">Llamar al 911</a>' : '') +
        '<button class="btn ghost" type="button" id="issueClose">Cerrar</button></div>';
      document.getElementById('issueClose').addEventListener('click', closeIssue);
      return;
    }
    m.innerHTML = '<div class="box"><h3>¿Qué pasó?</h3>' +
      (tipo === 'accidente' ? '<a class="btn sos" href="tel:911">Llamar al 911</a><p class="inc-note">Si hay heridos, llama primero. Después avísanos aquí.</p>' : '') +
      Object.keys(INC_TIPOS).map((k) => '<button type="button" class="opt' + (tipo === k ? ' on' : '') + '" data-k="' + k + '">' + esc(INC_TIPOS[k]) + '</button>').join('') +
      '<textarea id="issueNote" maxlength="300" placeholder="Cuéntanos qué pasó (opcional)">' + esc(keep) + '</textarea>' +
      '<div class="err inc-note" id="issueErr"></div>' +
      '<button class="btn primary" type="button" id="issueSend"' + (tipo ? '' : ' disabled') + '>Avisar a soporte</button>' +
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(supportUrl('Hola, soy ' + (S.name || 'repartidor') + ' de Gasca. Necesito ayuda con el pedido ' + folio(id) + '.')) + '">Hablar con soporte por WhatsApp</a>' +
      '<button class="btn ghost" type="button" id="issueClose">Cancelar</button></div>';
    m.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => { tipo = b.getAttribute('data-k'); draw(); }));
    document.getElementById('issueClose').addEventListener('click', closeIssue);
    document.getElementById('issueSend').addEventListener('click', async () => {
      const btn = document.getElementById('issueSend'); btn.disabled = true;
      const nota = document.getElementById('issueNote').value.trim().slice(0, 300), iid = newId();
      try {
        await setDoc(doc(db, 'incidencias', iid), { id: iid, orderId: id, driverId: S.uid, driverName: S.name || 'Repartidor', shop: o.shop || '', folio: folio(id), tipo, nota, estado: 'abierta', creadoEn: Date.now() });
        draw({ nota });
      } catch (e) { const er = document.getElementById('issueErr'); if (er) er.textContent = 'No se pudo enviar. Escríbenos por WhatsApp.'; btn.disabled = false; }
    });
  };
  draw();
}
function incDiv() {
  let el = document.getElementById('adminIncid');
  if (!el) { el = document.createElement('div'); el.id = 'adminIncid'; el.className = 'stack'; el.hidden = true; const ref = document.getElementById('adminSaldos'); ref.parentNode.insertBefore(el, ref.nextSibling); }
  return el;
}
function renderIncid(el) {
  const list = S.incs.slice().sort((a, b) => (a.estado === b.estado ? b.creadoEn - a.creadoEn : (a.estado === 'abierta' ? -1 : 1)));
  let h = '<h2 class="section">Incidencias</h2>';
  if (!list.length) { el.innerHTML = h + emptyBox('Sin incidencias', 'Cuando un repartidor reporte un problema en un pedido, aparece aquí.'); return; }
  h += list.map((x) => {
    const o = byId(x.orderId), open = x.estado === 'abierta', busy = S.busy.has('in' + x.id);
    const live = o && (o.estado === 'asignado' || o.estado === 'recogido');
    const wa = supportUrl('').split('?')[0];
    return '<article class="order"><div class="head"><span class="folio">' + esc(x.driverName || 'Repartidor') + '</span><span class="chip ' + (open ? 'abierto' : 'entregado') + '">' + (open ? 'Sin atender' : 'Atendida') + '</span><span class="ago">' + ago(x.creadoEn) + '</span></div>' +
      '<div class="line"><span class="k">Problema</span><span class="v"><b>' + esc(INC_TIPOS[x.tipo] || x.tipo) + '</b></span></div>' +
      (x.nota ? '<div class="line"><span class="k">Nota</span><span class="v">' + esc(x.nota) + '</span></div>' : '') +
      '<div class="line"><span class="k">Pedido</span><span class="v">' + esc(x.folio || '') + ' · ' + esc(x.shop || '') + (o ? ' · ' + esc(LABEL[o.estado] || o.estado) + ' · ' + esc(o.dest) : '') + '</span></div>' +
      (open ? '<div class="actions">' +
        (live ? '<button class="btn ghost small" type="button" data-act="inc-reopen" data-id="' + esc(x.id) + '" data-oid="' + esc(x.orderId) + '"' + (busy ? ' disabled' : '') + '>Reasignar pedido</button>' +
          '<button class="btn danger small" type="button" data-act="inc-cancel" data-id="' + esc(x.id) + '" data-oid="' + esc(x.orderId) + '"' + (busy ? ' disabled' : '') + '>Cancelar pedido</button>' : '') +
        '<button class="btn primary small" type="button" data-act="inc-ok" data-id="' + esc(x.id) + '"' + (busy ? ' disabled' : '') + '>Marcar atendida</button></div>' : '') + '</article>';
  }).join('');
  el.innerHTML = h;
}
async function incAct(id, fn, okMsg) {
  if (!S.isAdmin || S.busy.has('in' + id)) return;
  S.busy.add('in' + id); render();
  try { await fn(); toast(okMsg); } catch (e) { toast('No se pudo. Intenta de nuevo.'); }
  S.busy.delete('in' + id); render();
}
const incDone = (id) => incAct(id, () => updateDoc(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: Date.now() }), 'Incidencia atendida.');
const incReopen = (id, oid) => incAct(id, async () => {
  await updateDoc(doc(db, 'orders', oid), { estado: 'abierto', driverId: '', driverName: '', asignadoEn: null, recogidoEn: null });
  await updateDoc(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: Date.now(), accion: 'reasignado' });
}, 'Pedido liberado para otro repartidor.');
const incCancel = (id, oid) => incAct(id, async () => {
  await updateDoc(doc(db, 'orders', oid), { estado: 'cancelado', canceladoEn: Date.now() });
  await updateDoc(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: Date.now(), accion: 'cancelado' });
}, 'Pedido cancelado.');

(function () {
  const st = document.createElement('style');
  st.textContent = '.tabs-in[data-n="6"]{display:flex;overflow-x:auto;gap:6px;scrollbar-width:none}.tabs-in[data-n="6"]::-webkit-scrollbar{display:none}' +
    '.tabs-in[data-n="6"] .tab{flex:0 0 auto;white-space:nowrap;padding-inline:14px;font-size:14px}';
  document.head.appendChild(st);
})();


/* ---------- dirección de entrega por campos (para que Google Maps la encuentre bien) ---------- */
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const val = (id) => ($('#' + id).value || '').replace(/\s+/g, ' ').trim();
function buildDest() {
  let d = val('o-calle') + ' ' + val('o-num') + (val('o-int') ? ' Int. ' + val('o-int') : '') + ', Col. ' + val('o-col') + ', ' + val('o-ciudad') + ', ' + val('o-mun');
  const ref = val('o-ref');
  if (ref) { const room = 220 - d.length - 8; if (room > 0) d += ' — Ref: ' + ref.slice(0, room); }
  return d.slice(0, 220);
}
function buildPick() { return (val('p-calle') + ', Col. ' + val('p-col') + ', ' + val('p-ciudad') + ', ' + val('p-mun')).slice(0, 160); }
function saveCity() { lsSet('gasca_ciudad', val('o-ciudad')); lsSet('gasca_mun', val('o-mun')); if (val('p-ciudad')) lsSet('gasca_pciudad', val('p-ciudad')); if (val('p-mun')) lsSet('gasca_pmun', val('p-mun')); }
(function () {
  const pk = document.getElementById('o-pick'); if (!pk) return;
  const f = (id, label, ph, max) => '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="text" maxlength="' + max + '" placeholder="' + ph + '"></div>';
  pk.closest('.field').insertAdjacentHTML('afterend', '<div id="pickFields" hidden><div class="field sec-h"><label>Dirección de recolección</label></div>' +
    f('p-calle', 'Calle y número', 'Ej. Av. Insurgentes 100', 70) + f('p-col', 'Colonia', 'Ej. Condesa', 50) + f('p-ciudad', 'Ciudad', 'Ej. Tepic', 40) + f('p-mun', 'Municipio', 'Ej. Tepic', 40) + '</div>');
  $('#p-ciudad').value = lsGet('gasca_pciudad') || lsGet('gasca_ciudad'); $('#p-mun').value = lsGet('gasca_pmun') || lsGet('gasca_mun');
})();
(function () {
  const old = document.getElementById('o-dest'); if (!old) return;
  const box = old.closest('.field'); old.required = false; box.hidden = true;
  const f = (id, label, ph, max, req, extra) => '<div class="field"' + (extra || '') + '><label for="' + id + '">' + label + (req ? '' : ' (opcional)') + '</label><input id="' + id + '" type="text" maxlength="' + max + '"' + (req ? ' required' : '') + ' placeholder="' + ph + '"></div>';
  box.insertAdjacentHTML('beforebegin',
    '<div class="field sec-h"><label>Dirección de entrega</label></div>' +
    f('o-calle', 'Calle', 'Ej. Av. Insurgentes', 60, true) +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + f('o-num', 'Número exterior', 'Ej. 100', 10, true) + f('o-int', 'Interior', 'Ej. 4B', 10, false) + '</div>' +
    f('o-col', 'Colonia', 'Ej. Condesa', 50, true) +
    f('o-ciudad', 'Ciudad', 'Ej. Tepic', 40, true) +
    f('o-mun', 'Municipio', 'Ej. Tepic', 40, true) +
    f('o-ref', 'Referencias', 'Ej. Casa azul, entre calle X y Y', 60, false));
  $('#o-ciudad').value = lsGet('gasca_ciudad'); $('#o-mun').value = lsGet('gasca_mun');
})();

(function () { const m = document.getElementById('r-monto'); if (m) { m.min = '50'; m.placeholder = '$ mínimo 50'; } })();

(function () {
  const st = document.createElement('style');
  st.textContent = '.sec-h{margin:22px 0 14px!important;padding-bottom:6px;border-bottom:2px solid var(--line,#cfd6de)}.sec-h label{font-weight:800!important;font-size:17px!important;color:var(--ink,inherit)!important;letter-spacing:.02em}';
  document.head.appendChild(st);
})();

function cliSum() {
  const el = $('#paySum'); if (!el) return;
  const tp = (document.querySelector('input[name=ctipo]:checked') || {}).value || 'e', qp = (document.querySelector('input[name=cquien]:checked') || {}).value || 'r';
  const prod = tp === 'v' ? (Number($('#o-prod').value) || 0) : 0, T = Math.round(Number($('#o-tarifa').value) || 0);
  const f = (n) => '$' + (Math.round(n * 100) / 100);
  let h = '<b>Resumen</b>';
  if (tp === 'v') h += '<br>El repartidor te paga ' + f(prod) + ' al recoger.';
  if (tp === 'p') h += '<br>El producto ya está pagado. No se cobra el producto.';
  const tot = prod + (qp === 'r' ? T : 0);
  h += '<br>Al entregar se cobrará: <b>' + f(tot) + '</b>' + (qp === 'r' && tp === 'v' ? ' (' + f(prod) + ' producto + ' + f(T) + ' mandadito)' : '');
  if (qp === 'e') h += '<br>Tú pagas el mandadito (' + f(T) + ') al repartidor.';
  el.innerHTML = h;
}
(function () {
  const pair = document.querySelector('#orderForm .pair'); if (!pair) return;
  const card = (n, v, t, sm, chk) => '<label class="role"><input type="radio" name="' + n + '" value="' + v + '"' + (chk ? ' checked' : '') + '><span class="card-r"><b>' + t + '</b><small>' + sm + '</small></span></label>';
  pair.insertAdjacentHTML('beforebegin',
    '<div id="cliPay" hidden><div class="field sec-h"><label>¿Hay una venta de por medio?</label></div><div class="roles" style="grid-template-columns:1fr">' +
    card('ctipo', 'e', 'No, solo es un envío', 'Por ejemplo, un martillo prestado.', true) +
    card('ctipo', 'v', 'Sí, me pagan al entregar', 'El repartidor te paga el producto al recoger y lo cobra a quien recibe.') +
    card('ctipo', 'p', 'Sí, pero ya me pagaron', 'Por ejemplo, por transferencia. El repartidor no cobra el producto.') + '</div>' +
    '</div>' +
    '<div id="cliQuien" hidden><div class="field sec-h"><label>¿Quién paga el mandadito?</label></div><div class="roles" style="grid-template-columns:1fr">' +
    card('cquien', 'e', 'Paga quien envía', 'Tú le pagas al repartidor.') + card('cquien', 'r', 'Paga quien recibe', 'Se lo cobra el repartidor al entregar.', true) + '</div></div>' +
    '<div class="field" id="fProd" hidden style="margin-top:12px"><label for="o-prod">Valor del producto</label><input id="o-prod" type="number" inputmode="decimal" min="0" step="any" placeholder="$ precio del producto"><p class="hint" style="margin:6px 0 0">Solo si hay una venta. Si es un envío sin costo, déjalo vacío.</p></div>');
  pair.insertAdjacentHTML('afterend', '<div id="paySum" class="sumbox" hidden></div>');
  const f = $('#orderForm'); f.addEventListener('input', cliSum); f.addEventListener('change', cliSum); cliSum();
  const st = document.createElement('style');
  st.textContent = '.sumbox{margin:14px 0;padding:14px;border:2px dashed var(--line);border-radius:14px;background:var(--surface);line-height:1.5}.paynote{margin:10px 0;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--accent) 16%,var(--surface));line-height:1.45;font-size:15px}';
  document.head.appendChild(st);
})();
