/* Gasca · entregas certificadas. App web con Firebase (cuentas + Firestore). */
import { FIREBASE_CONFIG, OWNER_EMAIL } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail, verifyBeforeUpdateEmail, reload, setPersistence, browserLocalPersistence, browserSessionPersistence,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider
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
  users: [], aprobs: {}, wallets: {}, presence: {}, pruebas: {}, prRider: '', prMonto: '',
  review: null, revPhotos: null, suspId: null, delId: null, motivo: '',
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
    cambio: null, cambios: [],     profile: null, profileReady: false, role: null, name: '', addr: '', myAprob: null, aprReady: false, fotos: {},
    consent: false, verEdit: false, uploading: {}, perm: false, dbErr: false, tab: '',
    incs: [], incReady: false, ofertas: [], ofKnown: null, minOffer: 0, incMine: new Set(), regRead: false, regOk: false, regTop: 0, codes: {}, orders: [], openOrders: [], myOrders: [], known: new Set(), openReady: false, prev: new Map(),
    wallet: null, walletReady: false, movs: [], recargas: [], pago: '', pagoDirty: false,
    users: [], aprobs: {}, wallets: {}, presence: {}, pruebas: {}, prRider: '', prMonto: '', review: null, revPhotos: null, suspId: null, delId: null, motivo: '',
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
  if (document.visibilityState === 'visible') { if (S.online || S.isAgent) holdWake(); pushPresence(); }
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
const mapsUrl = (a) => 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(String(a || '').split(' — ')[0]);
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
    { k: 'selfie', t: 'Selfie', h: 'Una foto de tu cara, de frente y con buena luz. Sin lentes oscuros ni gorra. Es la foto que verán los negocios.', selfie: true },
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
const roleLbl = (u) => (isCli(u) ? 'Envío personal' : ROLE_LBL[u && u.role] || '');
const VER_CLI = [
  { k: 'local', t: 'Selfie', h: 'Una foto de tu cara, de frente y con buena luz. Sin lentes oscuros ni gorra.', selfie: true },
  { k: 'ine', t: 'INE por el frente', h: 'Foto de tu INE por el frente. Que se vean tu foto y tus datos completos.' },
  { k: 'ine_atras', t: 'INE por atrás', h: 'Foto de tu INE por la parte de atrás. Que se lea todo.' }
];
const slotsFor = (u) => (isCli(u) ? VER_CLI : VER[u && u.role] || []);
const telEmail = (x) => { const d = String(x || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) + TEL_DOM : ''; };
const telOf = (email) => { const e = String(email || ''); if (!e.endsWith(TEL_DOM)) return ''; const l = e.slice(0, -TEL_DOM.length); return /^\d+$/.test(l) ? l : ''; };
function fotoOk(k) { return !!safeImg(S.fotos[k]) && (!(S.profile && S.profile.cambioEn) || ((S.fotosT || {})[k] || 0) > S.profile.cambioEn); }
function safeImg(s) { return typeof s === 'string' && s.length < 260000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(s) ? s : ''; }
function personStatus(u, a) {
  const docsEn = (u && u.docsEn) || 0;
  if (a && a.estado === 'eliminado' && (a.en || 0) >= docsEn) return 'eliminado';
  if (a && a.estado === 'aprobado') return 'aprobado';
  if (a && a.estado === 'rechazado' && (a.en || 0) >= docsEn) return 'rechazado';
  return docsEn ? 'revision' : 'incompleto';
}
const verLabel = (st) => ({ eliminado: 'Dado de baja', revision: 'Documentos por revisar', incompleto: 'Sin documentos', rechazado: 'Documentos rechazados', aprobado: 'Aprobado' }[st] || '');
function myStatus() {
  if (!S.profileReady || !S.aprReady) return 'cargando';
  if (!S.profile) return 'perfil';
  return personStatus(S.profile, S.myAprob);
}
function view() {
  if (!S.ready || S.creating) return 'loading';
  if (!S.user) return 'auth';
  if (S.agChk) return 'loading';
  if (S.staffUnver || (S.ownerEmail && !S.isAdmin)) return 'owner';
  if (S.isAdmin) return 'admin';
  const st = myStatus();
  if (st === 'cargando') return 'loading';
  if (st === 'perfil') return 'profile';
  if (st !== 'aprobado') return 'verify';
  return S.role === 'shop' ? 'shop' : 'rider';
}

/* ---------- entrar y crear cuenta ---------- */
const af = $('#authForm');
(function injectPw() {
  const f1 = document.getElementById('fPass'); if (!f1) return;
  const st = document.createElement('style');
  st.textContent = '.pw-wrap{position:relative}.pw-wrap input{padding-right:56px!important}.pw-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:46px;height:46px;border:0;background:none;display:grid;place-items:center;cursor:pointer;color:#16202a;opacity:.7;border-radius:12px}.pw-eye:active{background:rgba(0,0,0,.06)}.pw-eye svg{width:26px;height:26px}';
  document.head.appendChild(st);
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  const f2 = f1.cloneNode(true); f2.id = 'fPass2'; f2.hidden = true;
  const l2 = f2.querySelector('label'); l2.setAttribute('for', 'a-pass2'); l2.textContent = 'Confirmar contraseña';
  const i2 = f2.querySelector('input'); i2.id = 'a-pass2'; i2.autocomplete = 'new-password'; i2.placeholder = 'Escríbela otra vez';
  f1.after(f2);
  [f1, f2].forEach((f) => {
    const inp = f.querySelector('input'), w = document.createElement('div'); w.className = 'pw-wrap';
    inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pw-eye'; b.setAttribute('aria-label', 'Mostrar contraseña'); b.innerHTML = EYE;
    b.addEventListener('click', () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; b.innerHTML = show ? OFF : EYE; b.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña'); });
    w.appendChild(b);
  });
})();
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
  const g = document.createElement('div'); g.className = 'field'; g.id = 'fRec'; g.hidden = true;
  g.innerHTML = '<label for="a-rec">Correo para recuperar tu contraseña (opcional)</label><input id="a-rec" type="email" autocomplete="email" placeholder="Ej. nombre@gmail.com"><small style="opacity:.75">Si algún día olvidas tu contraseña, te mandamos el enlace a este correo.</small>';
  f.after(g);
})();
const roleVal = () => (af.elements.role && af.elements.role.value) || '';
function setMode(m) {
  if (m === 'signup' && S.authMode !== 'signup') [...af.querySelectorAll('input[name=role]')].forEach((r) => { r.checked = false; });
  S.authMode = m; S.authErr = '';
  const su = m === 'signup', ow = m === 'owner', pr = m === 'profile', form = su || pr;
  $('#authTitle').textContent = { login: 'Entrar', signup: 'Crear cuenta', owner: S.soporteLink ? 'Equipo Gasca' : 'Administración', profile: 'Completa tu cuenta' }[m];
  $('#authLede').textContent = {
    login: 'Entra con tu correo y tu contraseña.',
    signup: 'Crea tu cuenta una sola vez. Después entras con tu correo y tu contraseña.',
    owner: S.soporteLink ? 'Bienvenido al equipo de Gasca. Si ya tienes contraseña, escríbela y toca Entrar. Si es tu primera vez, escribe una contraseña nueva y toca "Crear mi cuenta".' : 'Para el dueño y el equipo de soporte de Gasca.',
    profile: 'Elige quién eres para terminar de crear tu cuenta.'
  }[m];
  $('#authRoles').hidden = !form;
  $('#fName').hidden = !form;
  $('#fAddr').hidden = !(form && roleVal() === 'shop');
  $('#fEmail').hidden = pr; $('#fPass').hidden = pr; { const f2 = document.getElementById('fPass2'); if (f2) f2.hidden = !su; }
  $('#authHint').hidden = !form;
  $('#lblName').textContent = roleVal() === 'shop' ? 'Nombre del negocio' : 'Tu nombre';
  $('#a-name').placeholder = roleVal() === 'shop' ? 'Ej. Pizzería La Esquina' : 'Ej. Juan Pérez';
  $('#a-pass').autocomplete = su ? 'new-password' : 'current-password';
  $('#authBtn').textContent = { login: 'Entrar', signup: 'Crear cuenta', owner: 'Entrar', profile: 'Guardar' }[m];
  { const em = $('#a-email'); if (em) em.readOnly = !!(S.soporteLink && ow); }
  $('#authBtn2').hidden = !ow; $('#authBtn2').textContent = 'Crear mi cuenta (dueño o soporte)';
  { const cl = form && roleVal() === 'cliente', rp = su && roleVal() === 'rider';
    $('#fEmail').hidden = pr || cl || rp; $('#fTel').hidden = !(((su || (pr && !telOf(S.email))) && cl) || rp);
    $('#fRec').hidden = !(su && (cl || rp));
    $('#a-email').type = 'text';
    document.querySelector('label[for="a-email"]').textContent = m === 'login' ? 'Correo o teléfono' : 'Correo';
    if (cl) { $('#lblName').textContent = 'Tu nombre completo'; $('#a-name').placeholder = 'Ej. María López'; }
    if (rp) { $('#lblName').textContent = 'Tu nombre completo (como aparece en tu INE)'; $('#a-name').placeholder = 'Ej. Juan Pérez López'; }
    if (rp) { $('#authHint').textContent = ''; $('#authHint').hidden = true; }
    else if (cl) $('#authHint').textContent = 'Después te pediremos una selfie y tu INE por los dos lados para aprobar tu cuenta.';
    else $('#authHint').textContent = 'Después te pediremos fotos de tus documentos para aprobar tu cuenta.';
    if (m === 'login') $('#a-email').placeholder = 'correo o teléfono de 10 dígitos'; else $('#a-email').placeholder = 'tucorreo@ejemplo.com'; }
  const link = (act, txt) => '<button type="button" data-act="' + act + '">' + txt + '</button>';
  $('#authLinks').innerHTML = {
    login: link('mode-signup', 'Crear cuenta') + link('reset', 'Olvidé mi contraseña') + link('mode-owner', 'Administración'),
    signup: link('mode-login', 'Ya tengo cuenta'),
    owner: link('mode-login', 'Volver') + link('reset', 'Olvidé mi contraseña'),
    profile: link('signout', 'Salir')
  }[m];
  showErr();
}
function showErr() { const el = $('#authErr'); el.hidden = !S.authErr; el.textContent = S.authErr; }
function authMsg(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/email-already-in-use') return ((roleVal() === 'cliente' || roleVal() === 'rider') ? 'Ese teléfono ya tiene cuenta. Toca "Ya tengo cuenta".' : 'Ese correo ya tiene cuenta. Toca "Ya tengo cuenta" y entra con tu contraseña. Si te dieron de baja, al entrar podrás volver a solicitar tu ingreso.');
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
  if (p.role === 'rider') {
    const em = String((auth.currentUser && auth.currentUser.email) || '').toLowerCase().replace(/\+gasca-(negocio|repartidor|personal)(?=@)/, '');
    const t = String(p.tel || '').replace(/\D/g, '').slice(-10) || telOf(em);
    if (t) { try { await updateDoc(doc(db, 'users', uid), { addr: 'Tel ' + t }); } catch (e) {} }
  }
}
function setBusy(b) { S.authBusy = b; $('#authBtn').disabled = b; $('#authBtn2').disabled = b; }

af.addEventListener('change', (e) => { if (e.target && e.target.name === 'role') { const m = S.authMode; const keep = S.authErr; setMode(m); S.authErr = keep; showErr(); } });
af.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (S.authBusy) return;
  const m = S.authMode;
  let email = $('#a-email').value.trim().toLowerCase(); const pass = $('#a-pass').value;
  if (email && email.indexOf('@') < 0 && /^[\d\s+()-]+$/.test(email)) email = telEmail(email);
  const role = roleVal(), tel = $('#a-tel').value.replace(/\D/g, '').slice(-10), name = $('#a-name').value.trim(), sp = (i) => ($('#' + i).value || '').trim().replace(/\s+/g, ' '), addr = role === 'shop' ? [(sp('a-calle') + ' ' + sp('a-num')).trim(), 'Col. ' + sp('a-col'), sp('a-ciudad'), sp('a-mun')].join(', ').slice(0, 160) : '';
  const fail = (msg) => { S.authErr = msg; showErr(); };
  S.authErr = ''; showErr();
  const needProfile = () => {
    if (!role) return 'Elige si eres tienda, repartidor o cliente.';
    if ((role === 'cliente' || role === 'rider') && m === 'signup' && tel.length !== 10) return 'Escribe tu número de teléfono de 10 dígitos.';
    if (name.length < 2) return 'Escribe tu nombre.';
    if (role === 'shop' && (sp('a-calle').length < 3 || !sp('a-num') || sp('a-col').length < 2 || sp('a-ciudad').length < 2 || sp('a-mun').length < 2)) return 'Completa el domicilio de tu negocio: calle, número, colonia, ciudad y municipio.';
    return '';
  };
  try {
    if (m === 'login' || m === 'owner') {
      if (!email || !pass) return fail('Escribe tu correo o teléfono y tu contraseña.');
      if (m === 'owner' && email.indexOf('@') < 0) return fail('Escribe tu correo.');
      if (m === 'owner' && email !== OWNER) { try { localStorage.setItem('gasca_staff', email); } catch (e) {} }
      setBusy(true);
      try { await signInWithEmailAndPassword(auth, email, pass); }
      catch (e1) {
        const tl = telOf(email);
        if (tl && /invalid-credential|user-not-found|wrong-password|invalid-login/.test((e1 && e1.code) || '')) { const mail = await lookupMail(tl); if (mail) { lsSet('gasca_rectel_for_' + mail, tl); lsSet('gasca_realmail_for_' + tl, mail); await signInWithEmailAndPassword(auth, mail, pass); } else throw e1; } else throw e1;
      }
    } else if (m === 'signup') {
      const pe = needProfile(); if (pe) return fail(pe);
      if (role === 'cliente' || role === 'rider') email = telEmail(tel);
      if (!email) return fail('Escribe tu correo.');
      if (pass.length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
      { const p2 = document.getElementById('a-pass2'); if (p2 && p2.value !== pass) return fail('Las contraseñas no coinciden. Revísalas.'); }
      if (OWNER_OK && email === OWNER) return fail('Ese correo es del dueño. Usa "Soy el dueño".');
      setBusy(true); S.creating = true; render();
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await createProfile(cred.user.uid, { role, name, addr, tel });
      { const rm = (($('#a-rec') || {}).value || '').trim().toLowerCase(); if ((role === 'cliente' || role === 'rider') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rm)) { saveRecovery(rm, pass).catch(() => {}); } }
    } else if (m === 'profile') {
      const pe = needProfile(); if (pe) return fail(pe);
      const ptel = telOf(S.user && S.user.email) || (tel.length === 10 ? tel : '');
      if (role === 'cliente' && !ptel) return fail('Escribe tu número de teléfono de 10 dígitos.');
      setBusy(true);
      await createProfile(S.uid, { role, name, addr, tel: ptel });
    }
  } catch (err) { fail(authMsg(err)); }
  S.creating = false; setBusy(false); render();
});

async function ownerCreate() {
  if (S.authBusy) return;
  const email = $('#a-email').value.trim().toLowerCase(), pass = $('#a-pass').value;
  if (email.indexOf('@') < 0) { S.authErr = 'Escribe tu correo.'; showErr(); return; }
  if (email !== OWNER) { try { localStorage.setItem('gasca_staff', email); } catch (e) {} }
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
  if (!S.isAdmin && !S.agChk) toast('Todavía no aparece verificado. Toca el enlace del correo y vuelve a intentar.');
}
async function ownerResend() {
  try { await sendEmailVerification(auth.currentUser); toast('Te enviamos el correo otra vez.'); } catch (e) { toast('Espera un momento antes de pedirlo de nuevo.'); }
}
async function resetPass() {
  const raw = $('#a-email').value.trim().toLowerCase();
  if (raw && raw.indexOf('@') < 0 && /^[\d\s+()-]+$/.test(raw)) {
    const tl = raw.replace(/\D/g, '').slice(-10), mail = tl.length === 10 ? await lookupMail(tl) : '';
    if (mail) { try { await sendPasswordResetEmail(auth, mail); } catch (e) {} S.authErr = ''; showErr(); toast('Te enviamos un enlace a ' + maskMail(mail) + '. Revisa también spam.'); return; }
    S.authErr = 'Tu cuenta no tiene correo de recuperación. Escríbenos por WhatsApp al ' + SUPPORT_TEL + ' y te ayudamos.'; showErr(); return;
  }
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
  $('#a-pass').value = ''; { const p2 = document.getElementById('a-pass2'); if (p2) p2.value = ''; }
}

/* ---------- arranque de sesión ---------- */
function bootstrap(u) {
  stopAll(); resetData();
  S.user = u || null; S.ready = true;
  if (!u) { S.uid = null; S.email = ''; S.ownerEmail = false; S.isAdmin = false; $('#a-pass').value = ''; { const p2 = document.getElementById('a-pass2'); if (p2) p2.value = ''; } setMode('login'); render(); return; }
  S.uid = u.uid; S.email = (u.email || '').toLowerCase(); S.soporteLink = false;
  S.ownerEmail = OWNER_OK && S.email === OWNER;
  S.isAdmin = S.ownerEmail && u.emailVerified === true;
  if (S.ownerEmail && !S.isAdmin) { render(); return; }
  S.isAgent = false; S.isPartner = false; S.agChk = false; S.staffUnver = false; S.agentName = '';
  if (S.isAdmin) { S.tab = 'inicio'; startAdmin(); render(); return; }
  let staff = ''; try { staff = localStorage.getItem('gasca_staff') || ''; } catch (e) {}
  if (staff && staff === S.email) {
    if (u.emailVerified !== true) { S.staffUnver = true; render(); return; }
    S.agChk = true; render();
    getDoc(doc(db, 'agentes', S.email)).then((sn) => {
      if (S.uid !== u.uid) return;
      S.agChk = false;
      const d = sn.exists() ? sn.data() : null;
      if (d && d.activo !== false) { S.isAdmin = true; if (d.rol === 'socio') S.isPartner = true; else S.isAgent = true; S.agentName = d.name || 'Soporte'; S.tab = 'inicio'; startAdmin(); render(); pushPresence(); holdWake(); }
      else staffDeny('Este correo no está dado de alta en el equipo. Pídele al dueño que te agregue.');
    }).catch(() => { if (S.uid !== u.uid) return; S.agChk = false; staffDeny('No se pudo entrar a soporte. Avisa al dueño.'); });
    return;
  }
  startPerson();
  render();
}
function staffDeny(msg) {
  try { localStorage.removeItem('gasca_staff'); } catch (e) {}
  toast(msg); stopAll(); resetData();
  signOut(auth).catch(() => {});
}
onAuthStateChanged(auth, (u) => bootstrap(u));

function startPerson() {
  listen(unsubs, doc(db, 'users', S.uid), (s) => {
    S.profile = s.exists() ? s.data() : null; S.profileReady = true;
    if (S.profile) { S.role = S.profile.role; S.name = S.profile.name || ''; S.addr = isCli(S.profile) ? '' : (S.profile.addr || ''); if (!S.tab) S.tab = S.role === 'rider' ? 'disp' : 'nuevo'; }
    syncRole(); render();
  });
  unsubs.push(onSnapshot(doc(db, 'cambiosPerfil', S.uid), (s) => {
    const was = S.cambio; S.cambio = s.exists() ? s.data() : null;
    if (was && was.estado === 'pendiente' && S.cambio) {
      if (S.cambio.estado === 'aprobado') { beep([660, 990]); toast('Tus cambios de perfil fueron aprobados.'); }
      else if (S.cambio.estado === 'rechazado') toast('La administración no aprobó tus cambios de perfil.');
    }
    render();
  }, () => {}));
  listen(unsubs, doc(db, 'aprobaciones', S.uid), (s) => {
    const was = S.aprReady ? myStatus() : '';
    S.myAprob = s.exists() ? s.data() : null; S.aprReady = true;
    if (was && was !== 'aprobado' && was !== 'cargando' && myStatus() === 'aprobado') { beep([660, 990]); toast('Tu cuenta fue aprobada. Ya puedes entrar.'); }
    syncRole(); render();
  });
  listen(unsubs, collection(db, 'docs', S.uid, 'fotos'), (snap) => {
    const m = {}, tt = {};
    snap.docs.forEach((d) => { const x = d.data(); if (x && safeImg(x.img)) { m[d.id] = x.img; tt[d.id] = x.creadoEn || 0; } });
    S.fotos = m; S.fotosT = tt; render();
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
    S.openOrders.filter(liveR).filter(inMyZone).forEach((o) => m.set(o.id, o));
    S.myOrders.forEach((o) => m.set(o.id, o));
    S.orders = Array.from(m.values());
  } else { S.orders = S.myOrders; }
  S.orders.sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));
}
const orderDocs = (snap) => snap.docs.map((d) => d.data()).filter((o) => o && o.estado && o.id);

function bonoNotice(docs) {
  const k = 'gasca_bonos_' + S.uid; let seen = []; try { seen = JSON.parse(lsGet(k) || '[]'); } catch (e) {}
  const fresh = docs.filter((d) => (d.data() || {}).tipo === 'bono' && seen.indexOf(d.id) < 0);
  if (!fresh.length) return;
  lsSet(k, JSON.stringify(seen.concat(fresh.map((d) => d.id)).slice(-200)));
  const tot = fresh.reduce((t, d) => t + (Number(d.data().montoC) || 0), 0) / 100;
  const msg = 'Se agregaron ' + pesos(tot) + ' por recomendación';
  try { beep([660, 880, 1175]); buzz(); } catch (e) {} toast(msg + '. ¡Gracias por invitar!');
  try { if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) navigator.serviceWorker.ready.then((r) => r.showNotification('Gasca', { body: msg, icon: 'icon-192.png' })).catch(() => {}); } catch (e) {}
}
async function claimRef() {
  const ref = Number(lsGet('gasca_ref')); const k = 'gasca_refok_' + S.uid;
  if (!ref || lsGet(k) || S.role !== 'rider' || !S.uid) return;
  const born = (S.profile && S.profile.creadoEn) || 0;
  if (!born || Date.now() - born > 14 * 86400000 || ref === myRepNo()) { lsSet(k, '1'); return; }
  try { await setDoc(doc(db, 'referidos', S.uid), { refNo: ref, nombre: String(S.name || 'Repartidor').slice(0, 60), estado: 'pendiente', creadoEn: Date.now() }); } catch (e) { return; }
  lsSet(k, '1');
}
function startRole() {
  S.roleOn = true;
  if (S.role === 'rider') {
    S.online = lsGet('gasca_online_' + S.uid) !== '0'; if (S.online) { try { holdWake(); } catch (e) {} }
    ensureWallet();
    listen(roleUnsubs, query(collection(db, 'orders'), where('estado', '==', 'abierto')), onOpenOrders);
    listen(roleUnsubs, query(collection(db, 'orders'), where('driverId', '==', S.uid)), onMyOrders);
    listen(roleUnsubs, doc(db, 'wallets', S.uid), (s) => { S.wallet = s.exists() ? s.data() : null; S.walletReady = true; if (S.online) queueOpen(); syncSheet(); render(); });
    listen(roleUnsubs, query(collection(db, 'movs'), where('driverId', '==', S.uid)), (snap) => { S.movs = snap.docs.map((d) => d.data()); try { bonoNotice(snap.docs); } catch (e) {} render(); });
    setTimeout(() => { try { claimRef(); } catch (e) {} }, 4000);
    listen(roleUnsubs, query(collection(db, 'recargas'), where('driverId', '==', S.uid)), (snap) => { S.recargas = snap.docs.map((d) => d.data()).filter((r) => r && r.id && r.estado); render(); });
    listen(roleUnsubs, doc(db, 'config', 'pago'), (s) => { S.pago = (s.exists() && s.data().texto) || ''; render(); });
    listen(roleUnsubs, doc(db, 'config', 'zonas'), (s) => { S.zonas = (s.exists() && Array.isArray(s.data().zonas)) ? s.data().zonas : []; S.radioKm = (s.exists() && Number(s.data().radioKm)) || 3; mergeOrders(); syncSheet(); render(); });
    listen(roleUnsubs, doc(db, 'config', 'tarifas'), (s) => { S.tarifas = s.exists() ? s.data() : null; });
    roleUnsubs.push(onSnapshot(doc(db, 'fotosrep', S.uid), (sn) => { S.myThumb = sn.exists() ? (sn.data().img || '') : ''; render(); }, () => {}));
    listen(roleUnsubs, query(collection(db, 'ofertas'), where('driverId', '==', S.uid)), onOfertas);
    roleUnsubs.push(onSnapshot(query(collection(db, 'retiros'), where('driverId', '==', S.uid)), (snap) => { const m = Object.assign({}, S.retiros || {}); snap.docs.forEach((d) => { const v = d.data(); if (v && v.codigo) m[d.id] = v.codigo; }); S.retiros = m; render(); }, () => { S.retFail = true; render(); }));
    roleUnsubs.push(onSnapshot(query(collection(db, 'liberados'), where('driverId', '==', S.uid)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = (d.data() || {}).driverId || '-'; }); S.libres = m; render(); }, () => { S.retFail = true; render(); }));
  } else {
    roleUnsubs.push(onSnapshot(query(collection(db, 'liberados'), where('shopId', '==', S.uid)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = (d.data() || {}).driverId || '-'; }); S.libres = m; render(); }, () => {}));
    listen(roleUnsubs, query(collection(db, 'ofertas'), where('shopId', '==', S.uid)), onOfertas);
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
  next.filter(act).forEach((o) => { if (!was.some((w) => w.id === o.id) && !S.busy.has(o.id) && S.openReady) { beep([660, 990]); toast('Aceptaron tu oferta de ' + pesos(o.tarifa) + '. Ve por el pedido ' + folio(o.id) + '.'); if (myOferta(o.id)) { S.oc = o.id; S.ocRo = false; S.tab = 'disp'; } } });
  S.myOrders = next; mergeOrders(); syncSheet(); render();
}
function onOfertas(snap) {
  const next = snap.docs.map((d) => d.data()).filter((x) => x && x.id && x.orderId);
  if (S.ofKnown && S.role !== 'rider') next.forEach((x) => { if (x.estado === 'pendiente' && !S.ofKnown.has(x.id)) { beep([660, 880]); toast((x.driverName || 'Un repartidor') + ' pide ' + pesos(x.monto) + ' por tu pedido.'); } });
  S.ofKnown = new Set(next.map((x) => x.id)); S.ofertas = next; render();
}
const expMs = () => Number(lsGet('gasca_exp')) || 25000;
const isP = (o) => !!pdesc(o).tipo;
const liveR = (o) => !isP(o) || o.estado !== 'abierto' || Date.now() - (o.creadoEn || 0) < expMs() + 5000;
function deadline(o) { let t = o.creadoEn || 0; S.ofertas.forEach((x) => { if (x.orderId === o.id && x.estado === 'pendiente') t = Math.max(t, x.creadoEn || 0); }); return t + expMs(); }
const expiring = new Set();
const DRAFT_IDS = ['p-calle', 'p-col', 'p-ciudad', 'p-mun', 'o-cliente', 'o-tel', 'o-calle', 'o-num', 'o-int', 'o-col', 'o-ciudad', 'o-mun', 'o-ref', 'o-desc', 'o-prod', 'o-tarifa'];
function saveDraft(orderId) {
  const v = {}; DRAFT_IDS.forEach((i) => { v[i] = ($('#' + i) || {}).value || ''; });
  const r = (n) => (document.querySelector('input[name=' + n + ']:checked') || {}).value || '';
  lsSet('gasca_draft', JSON.stringify({ orderId, v, tipo: r('ctipo'), quien: r('cquien') }));
}
function restoreDraft(o) {
  let d = {}; try { d = JSON.parse(lsGet('gasca_draft') || '{}'); } catch (e) {}
  if (d.orderId === o.id && d.v) {
    DRAFT_IDS.forEach((i) => { const el = $('#' + i); if (el && d.v[i] != null) el.value = d.v[i]; });
    ['ctipo:' + d.tipo, 'cquien:' + d.quien].forEach((x) => { const [n, v] = x.split(':'); const el = document.querySelector('input[name=' + n + '][value="' + v + '"]'); if (el) el.checked = true; });
  }
  S.minOffer = Number(o.tarifa) || 0;
  $('#o-tarifa').value = S.minOffer;
  S.tab = 'nuevo'; cliSum(); beep([440, 330]);
  toast('Nadie tomó tu oferta de ' + pesos(S.minOffer) + '. Súbela o déjala igual y vuelve a pedir.');
  render();
}
async function expire(o) {
  if (expiring.has(o.id)) return;
  expiring.add(o.id);
  try {
    let ok = false;
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'orders', o.id), sn = await tx.get(ref);
      if (!sn.exists() || sn.data().estado !== 'abierto') return;
      tx.update(ref, { estado: 'cancelado', canceladoEn: Date.now() }); ok = true;
    });
    if (ok) restoreDraft(o);
  } catch (e) { expiring.delete(o.id); }
}
const expSeen = new Set();
const isExpired = (o) => o.estado === 'abierto' && isP(o) && Date.now() > deadline(o);
function checkExpiry() {
  if (S.role !== 'shop' || !isCli(S.profile)) return;
  let ch = false;
  S.orders.forEach((o) => {
    if (o.estado !== 'abierto' || !isP(o)) return;
    const ex = Date.now() > deadline(o);
    if (ex && !expSeen.has(o.id)) { expSeen.add(o.id); ch = true; if (S.tab === 'pedidos') beep([440, 330]); }
    if (!ex) expSeen.delete(o.id);
  });
  if (ch) { if (!S.tab || S.tab === 'nuevo') S.tab = 'pedidos'; render(); }
}
const S_reVal = {};
function expiredPanel(o) {
  const v = S_reVal[o.id] != null ? S_reVal[o.id] : o.tarifa, busy = S.busy.has('re' + o.id);
  return '<div class="paynote"><b>Nadie tomó tu oferta de ' + pesos(o.tarifa) + '.</b> Pon ' + pesos(o.tarifa) + ' o más para intentar de nuevo. Tus datos se conservan.' +
    '<div class="field" style="margin-top:10px"><label for="re-' + esc(o.id) + '">Tu nueva oferta por el mandadito</label><input id="re-' + esc(o.id) + '" data-re="' + esc(o.id) + '" type="number" inputmode="numeric" min="' + esc(o.tarifa) + '" step="1" value="' + esc(v) + '"></div>' +
    '<div class="actions" style="margin-top:8px"><button class="btn primary" type="button" data-act="re-offer" data-id="' + esc(o.id) + '"' + (busy || !canAct() ? ' disabled' : '') + '>' + (busy ? 'Enviando…' : 'Ofertar de nuevo') + '</button></div></div>';
}
async function reOffer(id) {
  const o = byId(id);
  if (!o || o.estado !== 'abierto' || !canAct() || S.busy.has('re' + id)) return;
  const el = document.getElementById('re-' + id), m = Math.round(Number(el && el.value) || 0);
  if (m < Number(o.tarifa)) { toast('Tu oferta debe ser de ' + pesos(o.tarifa) + ' o más.'); return; }
  if (m > 2000) { toast('La oferta máxima es de $2,000.'); return; }
  const d = pdesc(o), rec = d.tipo && d.quien === 'r';
  const cobro = Math.round((Number(o.cobro) - (rec ? Number(o.tarifa) : 0) + (rec ? m : 0)) * 100) / 100;
  const nid = newId(), codigo = String(1000 + Math.floor(Math.random() * 9000));
  S.busy.add('re' + id); render();
  try {
    const b = writeBatch(db);
    b.update(doc(db, 'orders', id), { estado: 'cancelado', canceladoEn: Date.now() });
    b.set(doc(db, 'orders', nid), { id: nid, estado: 'abierto', driverId: '', driverName: '', creadoEn: Date.now(), shopId: S.uid, shop: o.shop, pickup: o.pickup, cliente: o.cliente, tel: o.tel, dest: o.dest, desc: o.desc, cobro, tarifa: m });
    b.set(doc(db, 'codes', nid), { shopId: S.uid, codigo });
    await b.commit();
    delete S_reVal[id]; S.tab = 'pedidos';
    toast('Pedido enviado otra vez con ' + pesos(m) + '.');
    try { wzDone(nid); } catch (e2) {}
  } catch (e) { toast('No se pudo enviar. Intenta de nuevo.'); }
  S.busy.delete('re' + id); render();
}
document.addEventListener('input', (e) => { const t = e.target; if (t && t.getAttribute && t.getAttribute('data-re')) S_reVal[t.getAttribute('data-re')] = t.value; });
function cdNote(o) {
  if (o.estado !== 'abierto' || !isP(o)) return '';
  return '<p class="paynote">Tiempo para que alguien la tome: <b data-dl="' + deadline(o) + '">' + Math.max(0, Math.ceil((deadline(o) - Date.now()) / 1000)) + '</b> s</p>';
}
setInterval(() => {
  if (!S.user || !S.roleOn) return;
  if (S.role === 'rider') { const n = S.orders.length; mergeOrders(); if (S.orders.length !== n) { syncSheet(); render(); } }
  else { checkExpiry(); document.querySelectorAll('[data-dl]').forEach((el) => { el.textContent = Math.max(0, Math.ceil((Number(el.getAttribute('data-dl')) - Date.now()) / 1000)); }); }
}, 1000);
const myOferta = (oid) => S.ofertas.find((x) => x.id === oid + '_' + S.uid);
async function counter(id, m) {
  const o = byId(id);
  if (!canAct() || view() !== 'rider' || !o || o.estado !== 'abierto' || S.busy.has('of' + id)) return;
  if (!S.online) { toast('Conéctate para ofertar.'); return; }
  if (saldoC() < m * COM_C) { toast('Tu saldo no alcanza para esa oferta. Recarga.'); S.tab = 'saldo'; render(); return; }
  S.busy.add('of' + id); render();
  try {
    await setDoc(doc(db, 'ofertas', id + '_' + S.uid), { id: id + '_' + S.uid, orderId: id, shopId: o.shopId, driverId: S.uid, driverName: S.name || 'Repartidor', monto: m, estado: 'pendiente', creadoEn: Date.now() });
    toast('Pediste ' + pesos(m) + '. Si te aceptan, el pedido es tuyo.');
  } catch (e) { toast(e && e.code === 'permission-denied' ? 'No se pudo enviar la oferta. Avisa a la administración.' : 'No se pudo enviar la oferta. Intenta de nuevo.'); }
  S.busy.delete('of' + id); render();
}
async function offerYes(oid) {
  const of = S.ofertas.find((x) => x.id === oid), o = of && S.orders.find((x) => x.id === of.orderId);
  if (!of || !o || o.estado !== 'abierto' || S.busy.has('oy' + oid)) { toast('Ese pedido ya no está disponible.'); return; }
  S.busy.add('oy' + oid); render();
  try {
    const d = pdesc(o), rec = d.tipo && d.quien === 'r', cobro = Math.round((Number(o.cobro) - (rec ? Number(o.tarifa) : 0) + (rec ? Number(of.monto) : 0)) * 100) / 100;
    const b = writeBatch(db);
    b.update(doc(db, 'orders', o.id), { estado: 'asignado', driverId: of.driverId, driverName: of.driverName, asignadoEn: Date.now(), tarifa: of.monto, cobro });
    b.update(doc(db, 'ofertas', oid), { estado: 'aceptada' });
    await b.commit();
    toast('Aceptaste la oferta de ' + of.driverName + '.');
  } catch (e) { toast('No se pudo aceptar. Puede que otro repartidor ya tomó el pedido.'); }
  S.busy.delete('oy' + oid); render();
}
async function offerNo(oid) {
  if (S.busy.has('oy' + oid)) return;
  try { await updateDoc(doc(db, 'ofertas', oid), { estado: 'rechazada' }); } catch (e) { toast('No se pudo rechazar. Intenta de nuevo.'); }
}
function offerBtns(o) {
  const d = pdesc(o); if (!d.tipo || o.estado !== 'abierto') return '';
  const mine = myOferta(o.id);
  if (mine) return '<p class="paynote">' + (mine.estado === 'pendiente' ? 'Pediste <b>' + pesos(mine.monto) + '</b>. Esperando respuesta.' : mine.estado === 'rechazada' ? 'Tu oferta de ' + pesos(mine.monto) + ' no fue aceptada. Aún puedes aceptar ' + pesos(o.tarifa) + '.' : '') + '</p>';
  const t = Number(o.tarifa), busy = S.busy.has('of' + o.id);
  return '<p class="hint" style="margin:8px 0 4px">¿Muy poco? Pide más:</p><div class="actions">' + [5, 10].map((n) => '<button class="btn ghost" type="button" data-act="counter" data-id="' + esc(o.id) + '" data-m="' + (t + n) + '"' + (busy || !canAct() ? ' disabled' : '') + '>Pedir ' + pesos(t + n) + '</button>').join('') + '</div>';
}
S.drvFoto = S.drvFoto || {};
function drvImg(id) {
  if (!id) return '';
  if (!(id in S.drvFoto)) { S.drvFoto[id] = ''; getDoc(doc(db, 'fotosrep', id)).then((sn) => { const v = sn.exists() ? sn.data().img : ''; if (typeof v === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(v) && v.length < 40000) { S.drvFoto[id] = v; render(); } }).catch(() => {}); }
  return S.drvFoto[id] || '';
}
const drvAvatar = (id) => { const im = drvImg(id); return im ? '<img class="drv" alt="Foto del repartidor" src="' + im + '">' : ''; };
function offersFor(o) {
  const l = S.ofertas.filter((x) => x.orderId === o.id && x.estado === 'pendiente');
  if (o.estado !== 'abierto' || !l.length) return '';
  return '<div class="paynote"><b>Ofertas de repartidores</b>' + l.map((x) => '<div style="margin-top:8px"><b>' + esc(x.driverName) + '</b> pide <b>' + pesos(x.monto) + '</b> por el mandadito<div class="actions" style="margin-top:6px"><button class="btn ghost small" type="button" data-act="of-no" data-oid="' + esc(x.id) + '">Rechazar</button><button class="btn primary small" type="button" data-act="of-yes" data-oid="' + esc(x.id) + '"' + (S.busy.has('oy' + x.id) ? ' disabled' : '') + '>Aceptar ' + pesos(x.monto) + '</button></div></div>').join('') + '</div>';
}
function onOpenOrders(snap) {
  const open = orderDocs(snap), fresh = [];
  open.forEach((o) => {
    if (!S.known.has(o.id)) { S.known.add(o.id); if (S.openReady && Date.now() - (o.creadoEn || 0) < 120000) fresh.push(o); }
  });
  S.openReady = true; S.openOrders = open; mergeOrders();
  if (S.online) fresh.forEach((o) => { try { distFor(o); } catch (e) {} });
  if (rMode() === 'cerca' && S.pos) open.forEach((o) => { try { nearOk(o); } catch (e) {} });
  if (S.online && fresh.length) {
    fresh.sort((a, b) => b.creadoEn - a.creadoEn);
    let pushed = 0;
    fresh.forEach((o) => { if (!S.ignored.has(o.id) && inMyZone(o) && S.queue.indexOf(o.id) < 0) { S.queue.unshift(o.id); pushed++; } });
    if (pushed) { beep(); buzz(); }
  }
  syncSheet(); render();
}
function onShopOrders(snap) {
  const orders = orderDocs(snap);
  orders.forEach((o) => {
    const before = S.prev.get(o.id);
    if (S.openReady && before === 'abierto' && o.estado === 'asignado') { beep([660, 990]); toast((o.driverName || 'Un repartidor') + ' tomó el pedido ' + folio(o.id) + '.'); }
    if (S.openReady && (before === 'asignado' || before === 'recogido') && o.estado === 'entregado') { try { delivNotice(o); } catch (e2) {} }
    S.prev.set(o.id, o.estado);
  });
  S.openReady = true; S.myOrders = orders; mergeOrders(); render();
}
function queueOpen() {
  S.orders.filter((o) => o.estado === 'abierto' && !S.ignored.has(o.id))
    .sort((a, b) => b.creadoEn - a.creadoEn)
    .forEach((o) => { if (S.queue.indexOf(o.id) < 0) S.queue.push(o.id); });
}

function startAdmin() {
  if (!S.isAgent) listen(unsubs, query(collection(db, 'referidos'), limit(300)), (snap) => { S.referidos = snap.docs.map((d) => Object.assign({ uid: d.id }, d.data())); render(); });
  unsubs.push(onSnapshot(query(collection(db, 'liberados'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = (d.data() || {}).driverId || '-'; }); S.libres = m; render(); }, () => {}));
  listen(unsubs, query(collection(db, 'orders'), orderBy('creadoEn', 'desc'), limit(200)), (snap) => { S.myOrders = orderDocs(snap); mergeOrders(); render(); });
  listen(unsubs, query(collection(db, 'users'), limit(500)), (snap) => { S.users = snap.docs.map((d) => d.data()).filter((u) => u && u.id && u.role && u.name); render(); });
  listen(unsubs, query(collection(db, 'aprobaciones'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.aprobs = m; render(); assignRepNos(); });
  if (!S.isAgent) listen(unsubs, query(collection(db, 'recargas'), orderBy('creadoEn', 'desc'), limit(300)), (snap) => { S.recargas = snap.docs.map((d) => d.data()).filter((r) => r && r.id && r.estado); render(); });
  if (!S.isAgent) unsubs.push(onSnapshot(query(collection(db, 'cambiosPerfil'), limit(200)), (snap) => { S.cambios = snap.docs.map((d) => d.data()).filter((c) => c && c.uid); render(); }, () => {}));
  if (!S.isAgent) listen(unsubs, query(collection(db, 'agentes'), limit(50)), (snap) => { S.agentes = snap.docs.map((d) => d.data()).filter((a) => a && a.email); render(); });
  listen(unsubs, query(collection(db, 'wallets'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.wallets = m; render(); });
  if (!S.isAgent) listen(unsubs, query(collection(db, 'movs'), orderBy('creadoEn', 'desc'), limit(1000)), (snap) => { S.movs = snap.docs.map((d) => d.data()); render(); });
  listen(unsubs, query(collection(db, 'presence'), limit(500)), (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.presence = m; render(); });
  listen(unsubs, doc(db, 'config', 'pago'), (s) => { S.pago = (s.exists() && s.data().texto) || ''; render(); });
  listen(unsubs, doc(db, 'config', 'zonas'), (s) => { S.zonas = (s.exists() && Array.isArray(s.data().zonas)) ? s.data().zonas : []; S.radioKm = (s.exists() && Number(s.data().radioKm)) || 3; render(); });
  listen(unsubs, doc(db, 'config', 'tarifas'), (s) => { S.tarifas = s.exists() ? s.data() : null; });
  if (!S.isAgent) listen(unsubs, doc(db, 'config', 'pruebas'), (s) => { S.pruebas = (s.exists() && s.data().ids) || {}; render(); });
  listen(unsubs, query(collection(db, 'incidencias'), orderBy('creadoEn', 'desc'), limit(200)), (snap) => {
    const arr = snap.docs.map((d) => d.data()).filter((x) => x && x.id && x.tipo);
    if (S.incReady) arr.forEach((x) => { if (x.estado === 'abierta' && !S.incMine.has(x.id)) { beep([880, 660, 880]); buzz(); toast('Incidencia de ' + (x.driverName || 'un repartidor') + ': ' + (INC_TIPOS[x.tipo] || x.tipo)); } });
    arr.forEach((x) => S.incMine.add(x.id));
    S.incs = arr; S.incReady = true; render();
  });
}

/* Quién tiene la app abierta: cada teléfono avisa cada minuto. */
function pushPresence() {
  if (!S.uid || (S.isAdmin && !S.isAgent && !S.isPartner) || S.ownerEmail) return;
  if (S.isAgent || S.isPartner) { setDoc(doc(db, 'presence', S.uid), { online: true, lastSeen: Date.now(), role: S.isPartner ? 'socio' : 'soporte', name: S.email }).catch(() => {}); return; }
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

/* ---------- orden de compra: pantalla flotante del repartidor (no se guarda, se arma con los datos del pedido) ---------- */
const gen4 = () => String(Math.floor(1000 + Math.random() * 9000));
const isCamino = (id) => !!(S.camino && S.camino[id]) || lsGet('gasca_cam_' + id) === '1';
function isRel(o) { const v = S.libres && S.libres[o.id]; return !!v && (v === o.driverId || v === '-'); }
function isReleased(o) { return isRel(o) || !!S.retFail; }
const OCI = {
  nav: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 2 4.5 21 12 17.5 19.5 21z"/></svg>',
  map: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M9 3 3 5.5v15L9 18l6 2.5 6-2.5v-15L15 6zm0 2.2 4.5 1.9v11.7L9 15.9zM5 6.8l2-.8v10l-2 .8zm14 10.4-2 .8V8l2-.8z"/></svg>',
  tel: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z"/></svg>',
  wa: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8l-4 4V4a1 1 0 0 1 1-1zm3 5v1.6h10V8zm0 3.4V13h7v-1.6z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3h.5A2.5 2.5 0 0 1 20 12.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5v-7A2.5 2.5 0 0 1 6.5 10zm2 0h6V7a3 3 0 0 0-6 0z"/></svg>'
};
function slHtml(key, id, text, locked) {
  return '<div class="sl' + (locked ? ' lock' : '') + '" data-sl="' + key + '" data-id="' + esc(id) + '" role="button" tabindex="0" aria-label="' + esc(text) + '"><span class="sl-t">' + esc(text) + '</span><i class="sl-h">' + (locked ? OCI.lock : OCI.arrow) + '</i></div>';
}
function ocMoney(o) {
  const d = pdesc(o), T = Number(o.tarifa) || 0, P = d.prod || 0, cobro = Number(o.cobro) || 0, com = comC(o) / 100, rec = d.quien === 'r';
  let h = '<div class="oc-pay">' + (cobro > 0 ? 'PAGO: EFECTIVO · cobra ' + pesos(cobro) : 'No cobres nada al entregar' + (d.tipo && !rec ? ' · quien envía te paga el envío' : '')) + '</div>';
  if (d.tipo === 'v') h += '<div class="oc-pay2">Paga al restaurante ' + pesos(P) + ' en efectivo al recoger.</div><div class="oc-l"><span>Producto (para el restaurante)</span><b>' + pesos(P) + '</b></div>';
  h += '<div class="oc-l"><span>Envío (tu ganancia)</span><b>' + pesos(T) + '</b></div>';
  if (cobro > 0) h += '<div class="oc-tot"><span>Total a cobrar</span><b>' + pesos(cobro) + '</b></div>';
  h += '<div class="oc-com">Comisión por usar la app ' + m2(com) + ' · Te quedan ' + m2(T - com) + '</div>';
  return '<div class="oc-box"><div class="oc-h">Lo que lleva el repartidor</div>' + h + '</div>';
}
function ocHtml(o, ro) {
  const st = ordStatus(o), asig = o.estado === 'asignado', reco = o.estado === 'recogido', live = !ro && (asig || reco);
  const dp = destParts(o.dest), wa = waUrl(o.tel), rel = isReleased(o), code = S.retiros && S.retiros[o.id];
  const nav = mapsUrl(asig ? o.pickup : o.dest);
  let h = '<div class="oc-in"><div class="oc-bar"><button type="button" class="oc-back" data-act="oc-close">' + (live ? OCI.map + ' Ver mapa' : '← Volver') + '</button><b>Orden de compra</b><span class="oc-fol">' + folio(o.id) + '</span></div><div class="oc-body">';
  h += '<div class="oc-st"><span class="chip ' + esc(st.cls) + '">' + esc(st.t.split(' · ')[0]) + '</span></div>';
  h += '<div class="oc-sec"><div class="oc-k">Recoger en</div><div class="oc-n">' + esc(o.shop || 'Restaurante') + '</div><div class="oc-a">' + esc(o.pickup || '') + '</div></div>';
  if (live && asig) {
    h += code ? '<div class="oc-code"><small>Código para el restaurante</small><b>' + esc(code) + '</b><span>' + (rel ? '✅ El restaurante ya liberó tu pedido.' : '⏳ Dáselo al restaurante para que libere tu pedido.') + '</span></div>'
      : (rel ? '<div class="oc-ok">✅ Pedido liberado.</div>' : '<div class="oc-ok wait">⏳ Preparando tu código…</div>');
  } else if (live && reco) h += '<div class="oc-ok">✅ Pedido liberado y recogido.</div>';
  h += '<div class="oc-sec"><div class="oc-k">Entregar a</div><div class="oc-n">' + esc(o.cliente || 'Cliente') + '</div>' + (o.tel ? '<div class="oc-a">' + esc(o.tel) + '</div>' : '') +
    '<div class="oc-a">' + esc(dp.dir) + '</div>' + (dp.ref ? '<div class="oc-ref">Referencia: ' + esc(dp.ref) + '</div>' : '') + (pdesc(o).t ? '<div class="oc-ref">Lleva: ' + esc(pdesc(o).t) + '</div>' : '') + (EQL[pdesc(o).eq] ? '<div class="oc-ref"><b>Equipo: ' + EQL[pdesc(o).eq] + '</b></div>' : '') + '</div>';
  h += ocMoney(o);
  if (ro && (o.estado === 'cancelado' || o.liberado)) h += '<div class="oc-box"><div class="oc-h">Por qué no se entregó</div><div class="oc-a">' + esc(noReason(o) || 'Sin detalle.') + '</div></div>';
  if (live) {
    h += '<div class="oc-h2">Ruta ' + (asig ? 'al restaurante' : 'al cliente') + '</div><div class="oc-btns">' +
      '<a class="oc-b" href="' + esc(nav) + '" target="_blank" rel="noopener">' + OCI.nav + '<span>Google Maps</span></a>' +
      '<button type="button" class="oc-b" data-act="oc-close">' + OCI.map + '<span>Navegar en la app</span></button></div>';
    if (o.tel) h += '<div class="oc-btns two"><a class="oc-b flat" href="tel:' + esc(String(o.tel).replace(/[^\d+]/g, '')) + '">' + OCI.tel + '<span>Llamar</span></a>' + (wa ? '<a class="oc-b flat" href="' + esc(wa) + '" target="_blank" rel="noopener">' + OCI.wa + '<span>WhatsApp</span></a>' : '') + '</div>';
    if (reco) h += '<button type="button" class="oc-b wide" data-act="noans" data-id="' + esc(o.id) + '">⌛ El cliente no responde</button>';
    if (reco) h += '<button type="button" class="oc-b wide" data-act="libcode" data-id="' + esc(o.id) + '">🔑 Tengo un código de administración</button>';
    h += '<button type="button" class="oc-b wide" data-act="issue" data-id="' + esc(o.id) + '">🛟 Soporte · Tengo un problema</button>';
  }
  h += '</div>';
  if (live) h += '<div class="oc-foot">' + (asig ? (rel ? slHtml('picked', o.id, 'Desliza: ya tengo el pedido', false) : slHtml('picked', o.id, 'Espera: el restaurante debe liberarlo', true)) : (isCamino(o.id) ? slHtml('delivered', o.id, 'Desliza: marcar entregado', false) : slHtml('camino', o.id, 'Desliza: en camino', false))) + '</div>';
  return h + '</div>';
}
function ocOv() {
  let ov = document.getElementById('ocOv');
  if (!ov) { ov = document.createElement('div'); ov.id = 'ocOv'; ov.hidden = true; document.body.appendChild(ov); }
  return ov;
}
function ocFab() {
  let f = document.getElementById('gmOrd');
  if (!f) { f = document.createElement('button'); f.id = 'gmOrd'; f.type = 'button'; f.className = 'gm-ord'; f.setAttribute('data-act', 'oc-open'); f.hidden = true; f.textContent = '🧾 Ver orden'; document.body.appendChild(f); }
  const a = view() === 'rider' && !S.oc && S.tab === 'disp' && !S.sheetId ? mine().filter((x) => x.estado === 'asignado' || x.estado === 'recogido').sort((x, y) => (y.asignadoEn || 0) - (x.asignadoEn || 0))[0] : null;
  f.hidden = !a; if (a) f.setAttribute('data-id', a.id);
  f.style.position = 'fixed';
}
function ocSync() {
  ocFab();
  const ov = ocOv(), o = S.oc ? byId(S.oc) : null;
  const ok = !!o && view() === 'rider' && (S.ocRo || (o.driverId === S.uid && (o.estado === 'asignado' || o.estado === 'recogido')));
  if (!ok) {
    if (S.oc && o && !S.ocRo && o.estado === 'entregado') { /* terminó el viaje: la orden desaparece */ }
    S.oc = null; if (!ov.hidden) { ov.hidden = true; ov.innerHTML = ''; ov.dataset.h = ''; } document.body.classList.remove('oc-on'); return;
  }
  const h = ocHtml(o, S.ocRo);
  if (ov.dataset.h !== h) { const sc = ov.querySelector('.oc-body'), top = sc ? sc.scrollTop : 0; ov.innerHTML = h; ov.dataset.h = h; const nb = ov.querySelector('.oc-body'); if (nb) nb.scrollTop = top; }
  ov.hidden = false; document.body.classList.add('oc-on');
}
function slFire(key, id) {
  if (key === 'picked') picked(id);
  else if (key === 'camino') { S.camino = S.camino || {}; S.camino[id] = true; lsSet('gasca_cam_' + id, '1'); S.oc = null; UI_goMap(id); render(); }
  else if (key === 'delivered') askCode(id);
}
function UI_goMap(id) { try { const u = window.__gmap; if (u) { u.fitKey = ''; } S.tab = 'disp'; } catch (e) {} }
(function () {
  let cur = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest && e.target.closest('.sl-h'); if (!h) return;
    const sl = h.parentNode; if (sl.classList.contains('lock')) { toast('Espera a que el restaurante libere el pedido.'); return; }
    e.preventDefault(); cur = { sl, h, x0: e.clientX, max: Math.max(10, sl.clientWidth - h.offsetWidth - 8), id: e.pointerId, dx: 0 };
    try { h.setPointerCapture(e.pointerId); } catch (x) {} sl.classList.add('drag');
  });
  document.addEventListener('pointermove', (e) => {
    if (!cur || e.pointerId !== cur.id) return;
    cur.dx = Math.max(0, Math.min(cur.max, e.clientX - cur.x0)); cur.h.style.transform = 'translateX(' + cur.dx + 'px)'; cur.sl.style.setProperty('--p', (cur.dx / cur.max * 100) + '%');
  });
  const end = (e) => {
    if (!cur || e.pointerId !== cur.id) return; const c = cur; cur = null; c.sl.classList.remove('drag');
    if (c.dx >= c.max * 0.85) { c.h.style.transform = 'translateX(' + c.max + 'px)'; slFire(c.sl.dataset.sl, c.sl.dataset.id); setTimeout(() => { if (c.h.isConnected) { c.h.style.transform = ''; c.sl.style.setProperty('--p', '0%'); } }, 900); }
    else { c.h.style.transform = ''; c.sl.style.setProperty('--p', '0%'); }
  };
  document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  document.addEventListener('keydown', (e) => { const sl = e.target.closest && e.target.closest('.sl'); if (sl && (e.key === 'Enter' || e.key === ' ') && !sl.classList.contains('lock')) { e.preventDefault(); slFire(sl.dataset.sl, sl.dataset.id); } });
  const st = document.createElement('style');
  st.textContent = '#ocOv{position:fixed;inset:0;z-index:22;background:var(--bg);display:flex;justify-content:center}#ocOv[hidden]{display:none}.oc-in{width:100%;max-width:520px;display:flex;flex-direction:column;height:100%}' +
    '.oc-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:var(--surface);border-bottom:1px solid var(--line);font-size:17px}.oc-back{display:flex;align-items:center;gap:6px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);border-radius:12px;padding:8px 12px;font-weight:800;font-size:15px}.oc-fol{font-weight:800;color:var(--muted)}' +
    '.oc-body{flex:1;overflow:auto;padding:14px 14px 20px;display:flex;flex-direction:column;gap:12px}.oc-st .chip{font-size:14px}.oc-sec{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 14px}.oc-k{font-size:12.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.oc-n{font-size:21px;font-weight:800;margin-top:2px}.oc-a{font-size:16.5px;margin-top:2px}.oc-ref{font-size:14.5px;color:var(--muted);margin-top:3px}' +
    '.oc-code{background:#16202a;color:#fff;border-radius:16px;padding:14px;text-align:center}.oc-code small{display:block;opacity:.8;font-size:14px}.oc-code b{display:block;font-size:46px;letter-spacing:10px;margin:4px 0;color:#ffd24a}.oc-code span{font-size:15px;font-weight:700}' +
    '.oc-ok{background:color-mix(in srgb,var(--green) 16%,var(--surface));color:var(--green);border-radius:14px;padding:12px 14px;font-weight:800}.oc-ok.wait{background:#fff4d6;color:#8a5a00}' +
    '.oc-box{background:var(--surface2);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:7px}.oc-h{font-weight:800;font-size:17px}.oc-pay{background:color-mix(in srgb,var(--green) 16%,var(--surface));color:var(--green);font-weight:800;border-radius:10px;padding:10px 12px;font-size:16px}.oc-pay2{color:#c2620a;font-weight:800;font-size:15.5px}.oc-l{display:flex;justify-content:space-between;gap:10px;font-size:16px}.oc-l b{white-space:nowrap}.oc-tot{display:flex;justify-content:space-between;font-size:21px;font-weight:800;margin-top:2px}.oc-com{font-size:13.5px;color:var(--muted)}' +
    '.oc-h2{font-weight:800;font-size:17px;margin-top:4px}.oc-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px}.oc-btns.two{grid-template-columns:1fr 1fr}.oc-b{display:flex;align-items:center;justify-content:center;gap:10px;min-height:58px;padding:8px 10px;border:1.5px solid var(--line);background:var(--surface);color:var(--amber-fg);border-radius:14px;font-weight:800;font-size:16px;text-decoration:none;text-align:left}.oc-b.flat{border:0;background:none;justify-content:flex-start}.oc-b.wide{width:100%;justify-content:center}.oc-b svg{flex:none}' +
    '.oc-foot{padding:10px 14px calc(12px + env(safe-area-inset-bottom,0px));background:var(--surface);border-top:1px solid var(--line)}' +
    '.sl{position:relative;height:66px;border-radius:99px;background:color-mix(in srgb,#f08c00 22%,var(--surface));border:2.5px solid #f08c00;display:flex;align-items:center;justify-content:center;user-select:none;-webkit-user-select:none;overflow:hidden}.sl::before{content:"";position:absolute;left:0;top:0;bottom:0;width:var(--p,0%);background:rgba(240,140,0,.35)}.sl-t{position:relative;font-weight:800;font-size:18px;color:#a8530a;padding-left:56px}.sl-h{position:absolute;left:4px;top:4px;bottom:4px;width:54px;border-radius:50%;background:#f08c00;display:grid;place-items:center;touch-action:none;cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,.3)}.sl:not(.drag) .sl-h{transition:transform .2s}.sl.lock{border-color:#b8b8b8;background:var(--surface2)}.sl.lock .sl-h{background:#b0b0b0;cursor:not-allowed}.sl.lock .sl-t{color:var(--muted);font-size:15.5px}' +
    '.pf-ver{text-align:center;color:var(--muted);font-size:13px;margin:6px 0 0}.pf-title{text-align:center;font-size:21px;font-weight:800;margin:0 0 4px}.pf-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0 14px}.pf-pic{position:relative;width:104px;height:104px;border-radius:50%;background:var(--surface);border:3px solid #f4b400;display:grid;place-items:center;cursor:pointer;font-size:0}.pf-pic img{width:100%;height:100%;object-fit:cover;border-radius:50%}.pf-cam{position:absolute;right:-2px;bottom:-2px;width:34px;height:34px;border-radius:50%;background:#f08c00;display:grid;place-items:center;border:3px solid var(--bg)}.pf-nm{font-size:22px;font-weight:800;text-align:center;margin-top:6px;line-height:1.2}.pf-no{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:99px;padding:6px 16px}.pf-no small{font-size:13px;font-weight:700;color:var(--muted)}.pf-no b{font-size:18px;letter-spacing:.04em}.pf-hint{font-size:14px;color:var(--muted)}header.top{position:relative}#secPill{position:absolute;right:14px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--line);border-radius:99px;padding:7px 14px 7px 10px;box-shadow:0 2px 6px rgba(0,0,0,.1);color:var(--ink)}#secPill[hidden]{display:none}#secPill:not([data-act]){pointer-events:none}#secPill[data-act]{cursor:pointer;background:#16202a;color:#fff;border-color:#16202a}#secPill[data-act] i{color:#f6b400}#secPill[data-act]:active{transform:translateY(-50%) scale(.97)}#shareOv{position:fixed;inset:0;z-index:9990;background:rgba(10,15,20,.6);display:flex;align-items:center;justify-content:center;padding:18px}#shareOv[hidden]{display:none}#shareOv .sh{background:#fff;color:#16202a;border-radius:24px;max-width:380px;width:100%;padding:22px 20px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;position:relative;box-shadow:0 20px 50px rgba(0,0,0,.4)}#shareOv h2{margin:0;font-size:24px;font-weight:800;line-height:1.15}#shareOv p{margin:0;font-size:16px;color:#4a5560}#shareOv .shx{position:absolute;right:10px;top:8px;border:0;background:none;font-size:30px;line-height:1;color:#6b7683;padding:6px 10px}#shareOv .shq{background:#fff;border:3px solid #f6b400;border-radius:18px;padding:10px;width:230px;height:230px;display:grid;place-items:center}#shareOv .shq svg{width:100%;height:100%}#shareOv .shl{font-size:12.5px;color:#6b7683;word-break:break-all}#shareOv .shw{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:56px;border-radius:16px;background:#1fa855;color:#fff;font-weight:800;font-size:18px;text-decoration:none}#shareOv .shw svg{width:26px;height:26px;fill:#fff}#secPill i{display:grid;place-items:center;width:22px;height:22px;color:#f08c00}#secPill i svg{width:20px;height:20px}#secPill b{font-size:15px;font-weight:800;white-space:nowrap}.drv{width:46px;height:46px;border-radius:50%;object-fit:cover;flex:none;border:2px solid var(--line)}.status:has(.drv){display:flex;align-items:center;gap:10px}.pf-av{display:flex;align-items:center;gap:14px;padding:6px 4px}.pf-pic{width:76px;height:76px;border-radius:50%;background:var(--surface);border:2px solid var(--line);display:grid;place-items:center;overflow:hidden;font-size:30px}.pf-pic img{width:100%;height:100%;object-fit:cover}.pf-avt{font-weight:800;color:var(--amber-fg);font-size:16px}.gm-ord{position:absolute;right:12px;bottom:96px;border:0;background:#16202a;color:#fff;border-radius:99px;padding:11px 18px;font-weight:800;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.45)}.gm-ord[hidden]{display:none}.gm-attr{bottom:70px!important}.gm-chip{background:#fff4d6!important;border:1.5px solid #f0b429}' +
    '.mp-ver{margin-top:10px;width:100%;border:1.5px solid var(--line);background:var(--surface);color:var(--amber-fg);border-radius:12px;padding:10px;font-weight:800;font-size:15px}.lb-box{margin-top:6px}';
  document.head.appendChild(st);
})();


async function accept(id) {
  if (!canAct() || S.busy.has(id) || view() !== 'rider') return;
  if (!S.online) { toast('Conéctate para aceptar pedidos.'); return; }
  const raw = S.openOrders.find((x) => x.id === id);
  if (raw && !liveR(raw)) { toast('Ese pedido ya venció.'); return; }
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
    S.tab = 'disp'; S.oc = id; S.ocRo = false; S.queue = S.queue.filter((x) => x !== id);
    try { const cd = gen4(); S.retiros = S.retiros || {}; S.retiros[id] = cd; let k = 0; for (;;) { try { await setDoc(doc(db, 'retiros', id), { driverId: S.uid, shopId: (oo && oo.shopId) || (raw && raw.shopId) || '', codigo: cd, creadoEn: Date.now() }); break; } catch (e2) { if (++k >= 2) { S.retFail = true; break; } } } } catch (e3) { S.retFail = true; }
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
  if (!isReleased(o)) { toast('Espera: el restaurante debe liberar el pedido con tu código.'); return; }
  S.busy.add(id); render();
  try { await updateDoc(doc(db, 'orders', id), { estado: 'recogido', recogidoEn: Date.now() }); toast('Marcado como recogido.'); }
  catch (e) { toast('No se pudo actualizar. Intenta de nuevo.'); }
  S.busy.delete(id); render();
}

/* Entregar y descontar la comisión van juntas: o pasan las dos o no pasa ninguna. */
function deliveredLocal(id, o) {
  // actualiza la pantalla al instante, sin esperar al servidor
  [S.orders, S.myOrders, S.openOrders].forEach((l) => { (l || []).forEach((x) => { if (x && x.id === id) { x.estado = 'entregado'; x.entregadoEn = Date.now(); } }); });
}
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
    deliveredLocal(id, o);
    toast('Entrega registrada. Se descontó ' + cents(comC(o)) + ' de comisión.');
  } catch (e) {
    // si la entrega sí quedó guardada (mala señal, doble toque…), se da por buena
    try {
      const chk = await getDoc(doc(db, 'orders', id));
      if (chk.exists() && chk.data().estado === 'entregado' && chk.data().driverId === S.uid) {
        deliveredLocal(id, o); toast('Entrega registrada.'); S.busy.delete(id); render(); return true;
      }
    } catch (e2) {}
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
function thumbOf(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
    im.onload = () => {
      try {
        const w = im.naturalWidth, h = im.naturalHeight, m = Math.min(w, h), cv = document.createElement('canvas'); cv.width = cv.height = 160;
        const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, 160, 160); cx.drawImage(im, (w - m) / 2, (h - m) / 2, m, m, 0, 0, 160, 160);
        URL.revokeObjectURL(url); resolve(cv.toDataURL('image/jpeg', 0.7));
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
    if (key === 'selfie') { try { const th = await thumbOf(file); await setDoc(doc(db, 'fotosrep', S.uid), { img: th, creadoEn: Date.now() }); S.myThumb = th; } catch (e) { console.warn('miniatura', e); } }
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
  const have = slots.every((s) => fotoOk(s.k));
  if (!canAct() || !have || !S.consent || S.busy.has('verify')) return;
  if (!regDone()) return;
  S.busy.add('verify'); render();
  try {
    const upd = { docsEn: Date.now(), fotos: slots.map((s) => s.k) };
    if (!(S.profile && S.profile.reglamentoV === needV())) { upd.reglamentoEn = Date.now(); upd.reglamentoV = needV(); }
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
function uidByRep(n) { return Object.keys(S.aprobs || {}).find((k) => S.aprobs[k] && S.aprobs[k].repNo === n) || ''; }
const repLbl = (n) => 'R-' + String(n).padStart(3, '0');
function bonosHtml() {
  const l = (S.referidos || []).filter((r) => r.estado === 'pendiente').sort((a, b) => (a.creadoEn || 0) - (b.creadoEn || 0));
  let h = '<h2 class="section">Bonos por recomendación</h2>';
  if (!l.length) return h + emptyBox('Sin bonos pendientes', 'Cuando un repartidor invitado haga su primer pedido, aparece aquí para pagarle ' + pesos(BONO_C / 100) + ' a quien lo invitó.');
  return h + l.map((r) => {
    const inv = uidByRep(r.refNo), iu = S.users.find((u) => u.id === inv), n = S.myOrders.filter((o) => o.driverId === r.uid && o.estado === 'entregado' && !o.liberado).length;
    const dis = S.busy.has('bn' + r.uid) ? ' disabled' : '';
    return '<article class="order"><div class="head"><span class="folio">' + esc(r.nombre || 'Repartidor nuevo') + '</span><span class="chip ' + (n ? 'entregado' : 'abierto') + '">' + (n ? 'Ya entregó' : 'Aún sin pedido') + '</span><span class="ago">' + ago(r.creadoEn) + '</span></div>' +
      '<div class="line"><span class="k">Lo invitó</span><span class="v">' + (inv ? esc(repLbl(r.refNo) + ' · ' + ((iu && iu.name) || '')) : 'Número ' + esc(repLbl(r.refNo)) + ' (no encontrado)') + '</span></div>' +
      '<div class="line"><span class="k">Entregas del nuevo</span><span class="v">' + n + '</span></div>' +
      '<div class="actions"><button class="btn ghost small" type="button" data-act="bn-no" data-id="' + esc(r.uid) + '"' + dis + '>Rechazar</button><button class="btn primary small" type="button" data-act="bn-ok" data-id="' + esc(r.uid) + '"' + (dis || (n && inv ? '' : ' disabled')) + '>Pagar ' + pesos(BONO_C / 100) + '</button></div></article>';
  }).join('');
}
async function resolveBono(uid, ok) {
  const r = (S.referidos || []).find((x) => x.uid === uid), k = 'bn' + uid;
  if (!S.isAdmin || S.isAgent || !r || r.estado !== 'pendiente' || S.busy.has(k)) return;
  const inv = uidByRep(r.refNo); if (ok && !inv) { toast('No se encontró al repartidor que lo invitó.'); return; }
  S.busy.add(k); render();
  try {
    await runTransaction(db, async (tx) => {
      const rref = doc(db, 'referidos', uid), rs = await tx.get(rref);
      if (!rs.exists() || rs.data().estado !== 'pendiente') throw new Error('done');
      const now = Date.now();
      if (ok) {
        tx.set(doc(db, 'wallets', inv), { saldoC: increment(BONO_C) }, { merge: true });
        tx.set(doc(db, 'movs', 'bn_' + uid), { driverId: inv, tipo: 'bono', montoC: BONO_C, referido: uid, creadoEn: now });
      }
      tx.update(rref, { estado: ok ? 'pagado' : 'rechazado', resueltoEn: now });
    });
    toast(ok ? 'Bono pagado: ' + pesos(BONO_C / 100) + '.' : 'Bono rechazado.');
  } catch (e) { toast(e && e.message === 'done' ? 'Ese bono ya estaba resuelto.' : 'No se pudo completar. Intenta de nuevo.'); }
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
function repTag(id) { const a = S.aprobs[id] || {}, n = a.repNo; return (a.bajas ? '⚠ ' : '') + (n ? 'R-' + String(n).padStart(3, '0') + ' · ' : ''); }
function bajaLine(id) { const a = S.aprobs[id] || {}; return a.bajas ? '<div class="paynote"><b>⚠ Reingreso:</b> esta persona fue dada de baja ' + (a.bajas > 1 ? a.bajas + ' veces' : 'una vez') + (a.bajaEn ? ' (última: ' + new Date(a.bajaEn).toLocaleDateString("es-MX") + ')' : '') + '. Ponle más atención en sus pedidos.</div>' : ''; }
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
    if (prev.bajas) { data.bajas = prev.bajas; data.bajaEn = prev.bajaEn || 0; }
    await setDoc(doc(db, 'aprobaciones', id), data);
    S.review = null; S.revPhotos = null; S.motivo = ''; S.suspId = null;
    toast(ok ? 'Cuenta aprobada.' : 'Cuenta rechazada.');
  } catch (e) { toast('No se pudo guardar. Intenta de nuevo.'); }
  S.busy.delete(k); render();
}
async function setPrueba() {
  const uid = S.prRider || '', amt = Number(S.prMonto);
  if (!S.isAdmin || S.isAgent || S.busy.has('pr')) return;
  if (!uid) { toast('Elige un repartidor.'); return; }
  if (!(amt >= 1 && amt <= 5000)) { toast('Pon un monto entre $1 y $5,000.'); return; }
  S.busy.add('pr'); render();
  try {
    const mc = Math.round(amt * 100), b = writeBatch(db);
    b.set(doc(db, 'config', 'pruebas'), { ids: { [uid]: true } }, { merge: true });
    b.set(doc(db, 'wallets', uid), { saldoC: increment(mc) }, { merge: true });
    b.set(doc(db, 'movs', 'pr_' + newId()), { driverId: uid, tipo: 'prueba', montoC: mc, creadoEn: Date.now() });
    await b.commit();
    S.prMonto = ''; toast('Saldo de prueba puesto: ' + pesos(amt) + '.');
  } catch (e) { toast('No se pudo poner el saldo. Intenta de nuevo.'); }
  S.busy.delete('pr'); render();
}
async function zeroPrueba(uid) {
  const w = S.wallets[uid];
  if (!S.isAdmin || S.isAgent || !S.pruebas || !S.pruebas[uid] || !w || S.busy.has('pr0' + uid)) return;
  const cur = Number(w.saldoC) || 0; if (!cur) return;
  S.busy.add('pr0' + uid); render();
  try {
    const b = writeBatch(db);
    b.set(doc(db, 'wallets', uid), { saldoC: 0 }, { merge: true });
    b.set(doc(db, 'movs', 'pr_' + newId()), { driverId: uid, tipo: 'prueba', montoC: -cur, creadoEn: Date.now() });
    await b.commit(); toast('Saldo de prueba en $0.');
  } catch (e) { toast('No se pudo. Intenta de nuevo.'); }
  S.busy.delete('pr0' + uid); render();
}
(function () {
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'pr-monto') S.prMonto = e.target.value; });
  document.addEventListener('change', (e) => { if (e.target && e.target.id === 'pr-rider') S.prRider = e.target.value; });
})();
function copyCode(c) {
  if (!c) return;
  const fail = () => toast('Mantén presionado el código para copiarlo.');
  try { navigator.clipboard.writeText(c).then(() => toast('Código copiado.'), fail); } catch (e) { fail(); }
}

/* ---------- aviso de pedido nuevo (hoja inferior) ---------- */
const OFFER_MS = 40000;
function syncSheet() {
  if (!S.online || view() !== 'rider') { S.sheetId = null; S.gone = {}; S.seen = new Set(); renderSheet(); return; }
  S.gone = S.gone || {}; S.seen = S.seen || new Set();
  const now = Date.now(), keep = [];
  S.queue.forEach((id) => {
    if (S.ignored.has(id)) return;
    const o = byId(id);
    if (o && o.estado === 'abierto') { keep.push(id); return; }
    if (S.busy.has(id)) { keep.push(id); return; }
    if (o && o.driverId === S.uid) return; // me lo asignaron: ya no es un aviso
    if (!S.gone[id]) { S.gone[id] = now; setTimeout(() => { try { syncSheet(); } catch (e) {} }, 2500); }
    if (now - S.gone[id] < 2400) keep.push(id);
  });
  S.queue = keep;
  S.sheetId = keep.find((id) => { const o = byId(id); return o && o.estado === 'abierto'; }) || null;
  const fresh = keep.filter((id) => !S.seen.has(id));
  fresh.forEach((id) => S.seen.add(id));
  if (fresh.length && S.tab !== 'disp') { S.tab = 'disp'; setTimeout(() => { try { render(); } catch (e) {} }, 0); }
  renderSheet();
}
function sheetOffer(o) {
  const d = pdesc(o); if (!d.tipo || o.estado !== 'abierto') return '';
  const mo = myOferta(o.id);
  if (mo) return '<p class="sc-of">' + (mo.estado === 'pendiente' ? 'Pediste <b>' + pesos(mo.monto) + '</b>. Esperando respuesta…' : mo.estado === 'rechazada' ? 'No aceptaron tu oferta de ' + pesos(mo.monto) + '.' : '') + '</p>';
  const t = Number(o.tarifa), busy = S.busy.has('of' + o.id);
  return '<div class="sc-of"><span>Ofertar:</span>' + [5, 10].map((n) => '<button class="sc-o" type="button" data-act="counter" data-id="' + esc(o.id) + '" data-m="' + (t + n) + '"' + (busy || !canAct() ? ' disabled' : '') + '>Pedir ' + pesos(t + n) + '</button>').join('') + '</div>';
}
function sheetCard(id) {
  const o = byId(id), busy = S.busy.has(id);
  if (!o || (o.estado !== 'abierto' && !busy)) return '<div class="sc gone">Este pedido ya no está disponible.</div>';
  const dp = destParts(o.dest), gan = (Number(o.tarifa) || 0) - comC(o) / 100;
  const ok = busy ? '<button class="sc-ok" type="button" disabled>Aceptando…</button>'
    : (!canTake(o) ? '<button class="sc-ok low" type="button" data-act="tab" data-tab="saldo">Saldo insuficiente · Recargar</button>'
      : '<button class="sc-ok" type="button" data-act="accept" data-id="' + esc(o.id) + '">Aceptar · ' + m2(gan) + '</button>');
  return '<div class="sc" role="alertdialog" aria-label="Pedido nuevo"><div class="sc-h"><b>🔔 ' + esc(o.shop || 'Pedido nuevo') + '</b><span>' + folio(o.id) + '</span></div>' +
    '<div class="sc-l"><i>📍</i><span><small>Recoge en</small>' + esc(o.pickup || '') + '</span></div>' +
    '<div class="sc-l"><i>🏁</i><span><small>Entrega en</small>' + esc(dp.dir || '') + '</span></div>' +
    sheetOffer(o) +
    '<div class="sc-b"><button class="sc-no" type="button" data-act="ignore" data-id="' + esc(o.id) + '"' + (busy ? ' disabled' : '') + '>Rechazar</button>' + ok + '</div></div>';
}
function renderSheet(force) {
  const el = $('#sheet');
  const ids = view() === 'rider' && S.online && S.tab === 'disp' && !S.oc ? S.queue : [];
  const h = ids.length ? '<div class="sc-wrap">' + ids.map(sheetCard).join('') + '</div>' : '';
  if (!force && h === S.sheetKey) return;
  S.sheetKey = h;
  if (!h) { el.hidden = true; el.innerHTML = ''; return; }
  const w = el.querySelector('.sc-wrap'), top = w ? w.scrollTop : 0;
  el.hidden = false; el.innerHTML = h;
  const nw = el.querySelector('.sc-wrap'); if (nw) nw.scrollTop = top;
}
(function () {
  const st = document.createElement('style');
  st.textContent = '#riderMap .gm-chip{flex-direction:column;align-items:stretch;gap:8px}#riderMap .gm-chip span{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}#riderMap .gm-chip a{text-align:center;padding:10px 14px;font-size:15.5px}#riderMap .gm-attr{font-size:11px;color:#fff}' + '.sv-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:6px;color:var(--ink)}.sv-row>span{min-width:0;overflow-wrap:anywhere;font-weight:700}.sv-row b{white-space:nowrap;font-size:18px}.sv-row b.neg{color:#c0392b}.sv-row .btn{margin-left:6px}#prBox select{width:100%;min-height:48px;border:1.5px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);padding:0 10px;font-size:16px}#prBox{margin-top:14px}' + '#sheet.sheet{bottom:calc(80px + env(safe-area-inset-bottom,0px))!important;padding-inline:12px!important;z-index:21!important}.sc-wrap{pointer-events:auto;max-width:520px;margin-inline:auto;display:flex;flex-direction:column;gap:8px;max-height:min(58vh,470px);overflow:auto;padding:2px}' +
    '.sc{background:var(--surface);color:var(--ink);border:2px solid var(--accent);border-radius:16px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:7px;box-shadow:0 8px 24px rgba(0,0,0,.35);animation:rise .22s ease-out both}' +
    '.sc.gone{text-align:center;font-weight:700;padding:14px;border-color:var(--line)}' +
    '.sc-h{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:19px;line-height:1.15}.sc-h b{overflow-wrap:anywhere}.sc-h span{font-size:13px;font-weight:800;color:var(--muted);white-space:nowrap}' +
    '.sc-l{display:flex;gap:8px;align-items:flex-start;font-size:15.5px;line-height:1.25}.sc-l i{font-style:normal;flex:none}.sc-l span{display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere}.sc-l small{font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}' +
    '.sc-of{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;margin:0;color:var(--ink)}.sc-of span{font-weight:800}' +
    '.sc-o{border:1.5px solid var(--line);background:var(--surface2);color:var(--ink);border-radius:10px;padding:7px 12px;font-weight:800;font-size:14px}.sc-o:disabled{opacity:.55}' +
    '.sc-b{display:grid;grid-template-columns:auto 1fr;gap:8px;margin-top:2px}' +
    '.sc-no{min-height:50px;border:2px solid var(--line);background:var(--surface);color:var(--ink);border-radius:13px;padding:0 16px;font-weight:800;font-size:16px}' +
    '.sc-ok{min-height:50px;border:0;background:var(--accent);color:var(--on-accent);border-radius:13px;padding:0 12px;font-weight:800;font-size:16.5px}.sc-ok.low{background:var(--surface2);color:var(--ink);border:2px solid var(--line);font-size:14.5px}.sc-ok:disabled{opacity:.6}';
  document.head.appendChild(st);
})();
function offerKm(r) { return (r.m < 1000 ? Math.round(r.m / 10) * 10 + ' m' : (r.m / 1000).toFixed(1) + ' km') + ' · ~' + Math.max(1, Math.round(r.s / 60)) + ' min'; }
function offerBox(o) {
  const d = pdesc(o), T = pesos(o.tarifa), P = pesos(d.prod), rec = d.quien === 'r', rows = [];
  const row = (ic, cls, t) => '<div class="of-r ' + cls + '"><span>' + ic + '</span><span>' + t + '</span></div>';
  if (d.tipo === 'v') rows.push(row('🏪', 'pay', 'Tienes que pagar al restaurante ' + P + ' (pago en efectivo).'));
  if (d.tipo === 'p') rows.push(row('✅', 'pay', 'El producto ya está pagado: no pagues ni cobres el producto.'));
  rows.push(row('⏳', 'wait', 'Espera a que el restaurante libere tu pedido.'));
  if (d.tipo === 'v') rows.push(row('💵', 'get', rec ? 'Con el cliente: cobra ' + pesos(d.prod + Number(o.tarifa)) + ' (' + P + ' + ' + T + ' de envío).' : 'Con el cliente: cobra ' + P + '. El envío (' + T + ') te lo paga quien envía.'));
  else if (d.tipo) rows.push(row('💵', 'get', rec ? 'Con el cliente: cobra ' + T + ' de envío.' : 'Quien envía te paga ' + T + ' de envío. No cobres nada al entregar.'));
  else rows.push(row('💵', 'get', Number(o.cobro) > 0 ? 'Con el cliente: cobra ' + pesos(o.cobro) + '.' : 'Sin cobro con el cliente.'));
  return '<div class="of-box">' + rows.join('') + '</div>';
}
function tickOffer() {
  const el = document.getElementById('sheet'); if (!el || el.hidden || !S.sheetId) return;
  const b = el.querySelector('.of-ok'); if (!b) return;
  const el0 = Date.now() - (S.sheetAt || Date.now()), left = Math.max(0, Math.ceil((OFFER_MS - el0) / 1000));
  const t = b.querySelector('.of-t'), bar = b.querySelector('.of-bar');
  if (t && !b.disabled) { const x = 'Aceptar · ' + left + ' s'; if (t.textContent !== x) t.textContent = x; }
  b.classList.toggle('late', left <= 10);
  if (bar) bar.style.width = Math.min(100, el0 / OFFER_MS * 100) + '%';
}
setInterval(tickOffer, 250);

/* ---------- pantallas ---------- */
const emptyBox = (title, text) => '<div class="empty"><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>';
const DSEP = ' ¦';
function pdesc(o) {
  const d = String((o && o.desc) || ''), i = d.lastIndexOf(DSEP);
  if (i < 0) return { t: d };
  const m = d.slice(i + 2).split('|');
  if (!/^[evp]$/.test(m[0] || '') || !/^[re]$/.test(m[2] || '')) return { t: d };
  return { t: d.slice(0, i), tipo: m[0], prod: Number(m[1]) || 0, quien: m[2], eq: /^[mca]$/.test(m[3] || '') ? m[3] : '' };
}
const EQL = { m: '🎒 Mochila', c: '📦 Caja plástica' };
function eqNote(o) {
  const q = pdesc(o).eq; if (q !== 'm' && q !== 'c') return '';
  const t = q === 'm' ? '🎒 <b>Necesita mochila.</b> Son cosas ligeras.' : '📦 <b>Necesita caja plástica.</b> Son cosas pesadas o que no van en mochila. Si tu moto no tiene caja plástica, mejor no lo aceptes.';
  return '<p class="paynote">' + t + '</p>';
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
  return '<hr class="tear"><div class="money"><div class="fare">' + pesos(o.tarifa) + '<small>' + (pdesc(o).tipo ? 'ofrecen por el mandadito' : 'envío') + '</small></div>' +
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
    el.innerHTML = headH + '<div class="empty"><b>Tus documentos están en revisión</b><span>Tu solicitud será aprobada en un lapso de 24 horas.</span><span style="margin-top:10px;font-weight:700">⏳ Verificando documentos…</span></div>' +
      '<button class="btn ghost block" type="button" data-act="ver-edit">Cambiar mis documentos</button>';
    return;
  }
  if (st === 'eliminado' && S.swr) { renderSwitch(el); return; }
  const a = S.myAprob;
  let h = headH + '<p class="lede">' + (S.role === 'rider' ? 'Para recibir pedidos necesitamos 7 fotos. Solo sirven para confirmar quién eres.' : isCli(S.profile) ? 'Para pedir mandaditos necesitamos 3 fotos: tu selfie y tu INE por los dos lados. Solo sirven para confirmar quién eres.' : 'Para pedir motos necesitamos 3 fotos. Solo sirven para confirmar tu negocio.') + '</p>';
  if (st === 'eliminado') h += '<div class="banner"><b>Tu cuenta fue dada de baja.</b> Si quieres volver a usar Gasca, revisa tus documentos y envíalos otra vez. La administración los revisará con atención.</div><button class="btn ghost block" type="button" data-act="swr-open" style="margin:10px 0">Quiero entrar con otro perfil</button>';
  if (st === 'rechazado') h += '<div class="banner"><b>No se aprobaron tus documentos.</b> ' + esc(a && a.motivo ? a.motivo : 'Revisa las fotos y súbelas de nuevo.') + '</div>';
  let ready = 0;
  slots.forEach((s) => {
    const im = fotoOk(s.k) ? safeImg(S.fotos[s.k]) : '', up = !!S.uploading[s.k];
    if (im) ready++;
    h += '<div class="slot"><div class="t"><b>' + esc(s.t) + '</b>' + (up ? '<span class="chip abierto">Subiendo…</span>' : (im ? '<span class="chip entregado">Lista</span>' : '<span class="chip">Falta</span>')) + '</div>' +
      '<p class="hint">' + esc(s.h) + '</p>' + (im ? '<img class="thumb" src="' + im + '" alt="' + esc(s.t) + '">' : '') +
      '<input class="sr" type="file" accept="image/*"' + (s.selfie ? ' capture="user"' : '') + ' id="f-' + s.k + '" data-foto="' + s.k + '"' + (up ? ' disabled' : '') + '>' +
      '<label class="btn ' + (im ? 'ghost' : 'primary') + ' small" for="f-' + s.k + '">' + (im ? 'Cambiar foto' : 'Tomar o subir foto') + '</label></div>';
  });
  const all = ready === slots.length, sending = S.busy.has('verify');
  {
    const done = regDone(), rd = S.role === 'rider';
    h += '<h2 class="section">' + (rd ? 'Reglamento y aviso de privacidad' : 'Aviso de privacidad') + '</h2><p class="hint">Léelo completo hasta el final para poder aceptarlo.</p>' +
      '<div class="reg" id="regBox" tabindex="0">' + regHtml() + '</div>' +
      '<label class="check"><input type="checkbox" id="v-reg"' + (done ? ' checked' : '') + (S.regRead || done ? '' : ' disabled') + '><span>' + esc(rd ? REG_CONST : PRIV_CONST) + '</span></label>' +
      (S.regRead || done ? '' : '<p class="hint">Baja hasta el final del texto para activar esta casilla.</p>');
  }
  h += '<label class="check"><input type="checkbox" id="v-consent"' + (S.consent ? ' checked' : '') + '><span>Acepto que la administración use estas fotos solo para verificar mi identidad y mi negocio.</span></label>' +
    '<button class="btn primary block" type="button" data-act="ver-send"' + (all && S.consent && !sending && regDone() ? '' : ' disabled') + '>' + (sending ? 'Enviando…' : 'Enviar a revisión') + '</button>' +
    (all ? '' : '<p class="hint">Sube las ' + slots.length + ' fotos para poder enviar.</p>');
  el.innerHTML = h;
  const rb = document.getElementById('regBox'); if (rb) rb.scrollTop = S.regTop || 0;
}

function shopCard(o) {
  let s = '';
  if (o.estado === 'abierto') s = '<div class="status"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>Buscando repartidor</div>' + (isExpired(o) ? '' : '<button class="btn primary small block" type="button" data-act="wz-open" data-id="' + esc(o.id) + '">🛵 Ver cómo va la búsqueda</button>');
  else if (o.estado === 'asignado') s = '<div class="status">' + drvAvatar(o.driverId) + '<span><b>' + esc(o.driverName || 'Un repartidor') + '</b> va por el pedido · ' + ago(o.asignadoEn || o.creadoEn) + '</span></div>';
  else if (o.estado === 'recogido') s = '<div class="status">' + drvAvatar(o.driverId) + '<span><b>' + esc(o.driverName || 'El repartidor') + '</b> ya salió con el pedido</span></div>';
  const cod = S.codes[o.id];
  if (cod && (o.estado === 'abierto' || o.estado === 'asignado' || o.estado === 'recogido')) {
    const wa = waUrl(o.tel);
    s += '<div class="codebox"><small>Código de entrega · dáselo a tu cliente</small><b>' + esc(cod) + '</b><span>El repartidor lo necesita para terminar la entrega.</span>' +
      (wa ? '<a class="btn ghost small" target="_blank" rel="noopener" href="' + esc(wa + '?text=' + encodeURIComponent('Tu código de entrega es ' + cod + '. Dáselo al repartidor cuando llegue.')) + '">Enviar por WhatsApp</a>' : '') + '</div>';
  }
  if (o.estado === 'asignado') s += isRel(o) ? '<div class="lb-box status">✅ Ya liberaste este pedido.</div>' : '<div class="lb-box"><button class="btn primary block" type="button" data-act="liberar" data-id="' + esc(o.id) + '">🔓 Liberar pedido (código del repartidor)</button></div>';
  if (o.estado === 'entregado') s = '<div class="status">Entregado por <b>' + esc(o.driverName || 'el repartidor') + '</b></div>';
  let act = '';
  if (o.estado === 'abierto') {
    act = S.cancelId === o.id
      ? '<div class="actions"><button class="btn ghost small" type="button" data-act="cancel-no">Conservar</button><button class="btn danger small" type="button" data-act="cancel-yes" data-id="' + esc(o.id) + '">Sí, cancelar</button></div>'
      : '<div class="actions"><button class="btn ghost small" type="button" data-act="cancel" data-id="' + esc(o.id) + '"' + (S.busy.has(o.id) ? ' disabled' : '') + '>Cancelar pedido</button></div>';
  }
  return '<article class="order">' + head(o) + orderLines(o) + moneyRow(o) + sendNote(o) + (isExpired(o) ? expiredPanel(o) : offersFor(o) + cdNote(o)) + (isExpired(o) ? '' : s) + act + '</article>';
}
function histHtml(list) {
  const fin = list.filter((o) => o.estado === 'entregado' || o.estado === 'cancelado').sort((a, b) => lastAct(b) - lastAct(a));
  if (!fin.length) return emptyBox('Todavía no hay historial', 'Aquí se guardan tus pedidos entregados y cancelados.');
  const ok = fin.filter((o) => o.estado === 'entregado');
  const sum = ok.reduce((t, o) => t + (Number(o.tarifa) || 0), 0);
  const mes = ok.filter((o) => { const d = new Date(o.entregadoEn || o.creadoEn), n = new Date(); return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear(); });
  let h = '<h2 class="section">Historial</h2><div class="sumbox"><div class="line"><span class="k">Entregados</span><span class="v">' + ok.length + '</span></div>' +
    '<div class="line"><span class="k">Este mes</span><span class="v">' + mes.length + ' · ' + pesos(mes.reduce((t, o) => t + (Number(o.tarifa) || 0), 0)) + ' en envíos</span></div>' +
    '<div class="line"><span class="k">Total pagado en envíos</span><span class="v">' + pesos(sum) + '</span></div></div>';
  let day = '';
  fin.forEach((o) => {
    const t = lastAct(o), dk = new Date(t).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    if (dk !== day) { day = dk; h += '<div class="subhead">' + esc(dk) + '</div>'; }
    h += '<article class="order">' + head(o) + orderLines(o) + moneyRow(o) +
      (o.estado === 'entregado' ? '<div class="status">Entregado por <b>' + esc(o.driverName || 'el repartidor') + '</b> · ' + new Date(o.entregadoEn || t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) + (o.liberado ? '<br><small>🔑 Entrega liberada por administración (el cliente no contestó)</small>' : '') + '</div>' : '') + '</article>';
  });
  return h;
}
function renderShop() {
  const list = S.orders;
  const active = list.filter((o) => o.estado === 'abierto' || o.estado === 'asignado' || o.estado === 'recogido');
  $('#shopNew').hidden = S.tab !== 'nuevo';
  const el = $('#shopList'); el.hidden = S.tab !== 'pedidos';
  if (S.tab === 'pedidos') {
    if (!S.openReady) el.innerHTML = emptyBox('Cargando pedidos', 'Un momento.');
    else {
      const cur = list.filter((o) => o.estado !== 'entregado' && o.estado !== 'cancelado');
      el.innerHTML = cur.length ? '<h2 class="section">Mis pedidos</h2><div class="list">' + cur.map(shopCard).join('') + '</div>'
        : emptyBox(list.length ? 'No tienes pedidos en curso' : 'Aún no hay pedidos', list.length ? 'Tus pedidos terminados están en Historial.' : 'Cuando generes un pedido, aquí ves quién lo tomó y en qué va.');
    }
  }
  { let hv = $('#shopHist');
    if (!hv) { hv = document.createElement('div'); hv.id = 'shopHist'; hv.className = 'stack'; el.parentNode.insertBefore(hv, el.nextSibling); }
    hv.hidden = S.tab !== 'historial';
    if (S.tab === 'historial') hv.innerHTML = !S.openReady ? emptyBox('Cargando historial', 'Un momento.') : histHtml(list); }
  { const mn = $('#minNote'); mn.hidden = !(isCli(S.profile) && S.minOffer); mn.textContent = 'Nadie tomó tu oferta de ' + pesos(S.minOffer) + '. Pon ' + pesos(S.minOffer) + ' o más para intentar de nuevo.'; $('#o-tarifa').min = isCli(S.profile) && S.minOffer ? String(S.minOffer) : '1'; }
  { const cli = isCli(S.profile); $('#cliEq').hidden = !cli; $('#cliPay').hidden = !cli; $('#cliQuien').hidden = !cli; $('#fProd').hidden = !cli; $('#paySum').hidden = !cli; $('#o-cobro').closest('.field').hidden = cli; $('#orderForm .pair').style.gridTemplateColumns = cli ? '1fr' : '';
    $('label[for=o-tarifa]').textContent = cli ? 'Oferta por el mandadito' : 'Pago al repartidor'; $('#o-tarifa').placeholder = cli ? '$ cuánto ofreces pagar por el mandadito' : '$ envío';
    $('label[for=o-desc]').textContent = cli ? '¿Qué vas a enviar?' : 'Qué se entrega'; $('#o-desc').placeholder = cli ? 'Ej. Un martillo, zapatos escolares' : 'Ej. 2 pizzas grandes y 1 refresco'; }
  { const cli = isCli(S.profile), pk = $('#o-pick'), box = pk.closest('.field'), pf = $('#pickFields');
    const fixed = !cli && !!S.addr, pt = $('#pickTxt');
    if (box) box.hidden = cli || fixed; pk.required = !cli && !fixed;
    if (pt) { pt.hidden = !fixed; if (fixed) { const h = '<b>📍 Recolección</b><br>' + esc(S.addr) + '<br><small>Aquí recogerán los repartidores. Para cambiarla: Menú → Editar perfil (la revisa la administración).</small>'; if (pt.dataset.h !== h) { pt.dataset.h = h; pt.innerHTML = h; } } }
    if (pf) { pf.hidden = !cli; ['p-calle', 'p-col', 'p-ciudad', 'p-mun'].forEach((i) => { $('#' + i).required = cli; }); } }
  if (!isCli(S.profile) && S.addr && document.activeElement !== $('#o-pick') && (!$('#o-pick').value || $('#o-pick').value === window.__pickFrom)) { $('#o-pick').value = S.addr; window.__pickFrom = S.addr; }
  return [{ id: 'nuevo', label: 'Nuevo pedido' }, { id: 'pedidos', label: 'Mis pedidos', badge: active.length }, { id: 'historial', label: 'Historial' }];
}

function acceptBtn(o, busy) {
  if (!S.walletReady || !S.wallet) return '<button class="btn ghost" type="button" disabled>Cargando saldo…</button>';
  if (!S.online) return '<button class="btn ghost" type="button" data-act="online">Conéctate para aceptar pedidos</button>';
  if (!canTake(o)) return '<button class="btn ghost" type="button" data-act="tab" data-tab="saldo">Saldo insuficiente · Recargar</button>';
  return '<button class="btn primary" type="button" data-act="accept" data-id="' + esc(o.id) + '"' + (busy || !canAct() ? ' disabled' : '') + '>' + (busy ? 'Aceptando…' : 'Aceptar pedido') + '</button>';
}
function availCard(o) {
  return '<article class="order">' + head(o) +
    '<div class="line"><span class="k">Recoger en</span><span class="v">' + esc(o.shop) + ' · ' + esc(o.pickup) + zoneTag(o) + '</span></div>' +
    '<div class="line"><span class="k">Entregar en</span><span class="v">' + esc(o.dest) + '</span></div>' + distLine(o) +
    '<div class="line"><span class="k">Lleva</span><span class="v">' + esc(pdesc(o).t) + '</span></div>' +
    moneyRow(o) + eqNote(o) + payNote(o) +
    '<p class="hint">Comisión de ' + cents(comC(o)) + ' (13%) al entregar.</p>' +
    '<div class="actions">' + acceptBtn(o, S.busy.has(o.id)) + '</div>' + offerBtns(o) + '</article>';
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
    moneyRow(o) + eqNote(o) + payNote(o) + links + '<div class="actions">' + btn + '</div>' +
    (o.estado === 'recogido' ? '<button class="btn ghost small block" type="button" data-act="noans" data-id="' + esc(o.id) + '">📵 Ya llegué y no sale el cliente</button>' : '') +
    (o.estado === 'recogido' ? '<button class="btn primary small block" type="button" data-act="libcode" data-id="' + esc(o.id) + '">🔑 Tengo un código de administración</button>' : '') +
    '<button class="btn ghost small block" type="button" data-act="issue" data-id="' + esc(o.id) + '">Tengo un problema</button></article>';
}
function pfDiv() {
  let el = document.getElementById('riderPerfil');
  if (!el) { el = document.createElement('div'); el.id = 'riderPerfil'; el.className = 'stack'; el.hidden = true; const ref = document.getElementById('riderWallet'); ref.parentNode.insertBefore(el, ref.nextSibling); }
  return el;
}
const PI = {
  moon: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.4 14.6A8.6 8.6 0 0 1 9.4 3.6a.7.7 0 0 0-.9-.9A9.8 9.8 0 1 0 21.3 15.5a.7.7 0 0 0-.9-.9z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22a2.3 2.3 0 0 0 2.2-1.7H9.8A2.3 2.3 0 0 0 12 22zm7-5.2V11a7 7 0 0 0-5.5-6.8V3.5a1.5 1.5 0 0 0-3 0v.7A7 7 0 0 0 5 11v5.8l-1.7 1.7v.9h17.4v-.9z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M7 10V7a5 5 0 0 1 10 0v3h.5A2.5 2.5 0 0 1 20 12.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5v-7A2.5 2.5 0 0 1 6.5 10zm2 0h6V7a3 3 0 0 0-6 0zm3 4.2a1.6 1.6 0 0 0-.8 3V19h1.6v-1.8a1.6 1.6 0 0 0-.8-3z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.5a1.4 1.4 0 1 1 2.8 0 1.4 1.4 0 0 1-2.8 0zm5.2-.9h12.6a.9.9 0 0 1 0 1.8H8.2a.9.9 0 0 1 0-1.8zM3 12a1.4 1.4 0 1 1 2.8 0A1.4 1.4 0 0 1 3 12zm5.2-.9h12.6a.9.9 0 0 1 0 1.8H8.2a.9.9 0 0 1 0-1.8zM3 18.5a1.4 1.4 0 1 1 2.8 0 1.4 1.4 0 0 1-2.8 0zm5.2-.9h12.6a.9.9 0 0 1 0 1.8H8.2a.9.9 0 0 1 0-1.8z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5h18a1 1 0 0 1 1 1v.5l-10 6.5L2 6.5V6a1 1 0 0 1 1-1zm-1 4.1 10 6.5 10-6.5V18a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2 4 5.2v6c0 5 3.4 9.3 8 10.8 4.6-1.5 8-5.8 8-10.8v-6zm-1 6h2v2h-2zm0 4h2v5h-2z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9M16 8l4 4-4 4M20 12H9"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>'
};
function isDarkNow() { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }
function notifOn() { return 'Notification' in window && Notification.permission === 'granted' && lsGet('gasca_notif') !== '0'; }
function pfRow(act, ico, label, sw) {
  return '<button type="button" class="pf-row" data-act="' + act + '"' + (sw ? ' role="switch" aria-checked="' + (sw === 'on') + '"' : '') + '><span class="pf-i">' + PI[ico] + '</span><span class="pf-l">' + label + '</span>' +
    (sw ? '<span class="pf-sw' + (sw === 'on' ? ' on' : '') + '"><i></i></span>' : '') + '</button>';
}
function fmtFH(t) {
  const d = new Date(t || Date.now()), z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}
const m2 = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function renderMisPedidos(el, my) {
  const fin = my.filter((o) => o.estado === 'entregado' || o.estado === 'cancelado').sort((a, b) => (b.entregadoEn || b.canceladoEn || b.creadoEn || 0) - (a.entregadoEn || a.canceladoEn || a.creadoEn || 0));
  const card = (o) => {
    const canc = o.estado === 'cancelado', lib = !canc && o.liberado;
    const st = canc ? ['Cancelado', 'var(--red)'] : lib ? ['Liberado', 'var(--amber-fg)'] : ['Entregado', 'var(--green)'];
    const com = canc ? 0 : comC(o) / 100, gan = canc ? 0 : (Number(o.tarifa) || 0) - com;
    return '<article class="mp-card"><div class="mp-top"><b>' + esc(o.shop || 'Negocio') + '</b><span style="color:' + st[1] + '">' + st[0] + '</span></div>' +
      '<div class="mp-sol">Solicitud ' + folio(o.id) + '</div><div class="mp-fh">' + fmtFH(o.entregadoEn || o.canceladoEn || o.creadoEn) + '</div>' +
      '<div class="mp-dir">' + esc(destParts(o.dest).dir) + '</div><div class="mp-money"><b>Ganancia: ' + pesos(gan) + '</b><span>Comisión por usar la app: ' + pesos(com) + '</span></div><button type="button" class="mp-ver" data-act="oc-ro" data-id="' + esc(o.id) + '">Ver orden de compra</button></article>';
  };
  const h = '<div class="mp-sub">Entregas Gasca (' + fin.length + ')</div>' + (fin.length ? fin.slice(0, S.mpN || 50).map(card).join('') : '<p class="hint">Aquí aparecerán tus pedidos entregados.</p>') +
    (fin.length > (S.mpN || 50) ? '<button type="button" class="btn ghost block" data-act="mp-more">Ver más (' + (fin.length - (S.mpN || 50)) + ' anteriores)</button>' : '');
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
function renderEnCurso(el, list) {
  const card = (o, i) => {
    const wait = i > 0, st = wait ? ['En espera', 'var(--amber-fg)'] : ['En curso', 'var(--blue)'];
    const com = comC(o) / 100, gan = (Number(o.tarifa) || 0) - com;
    return '<article class="mp-card mp-go" role="button" tabindex="0" data-act="oc-open" data-id="' + esc(o.id) + '"><div class="mp-top"><b>' + esc(o.shop || 'Negocio') + '</b><span style="color:' + st[1] + '">' + (wait ? 'Pedido en espera' : 'Pedido en curso') + '</span></div>' +
      '<div class="mp-sol">Solicitud ' + folio(o.id) + '</div><div class="mp-fh">' + fmtFH(o.asignadoEn || o.creadoEn) + '</div>' +
      '<div class="mp-dir">' + esc(destParts(o.dest).dir) + '</div><div class="mp-money"><b>Pago por el envío: ' + m2(o.tarifa) + '</b><span>Ganancia: ' + m2(gan) + '</span><span>Comisión por usar la app: ' + m2(com) + '</span></div>' +
      '<div class="mp-hint">Toca para ver la orden de compra</div></article>';
  };
  const h = list.length ? list.map(card).join('') : '<p class="hint" style="text-align:center;margin-top:30px">No tienes pedidos en curso.</p>';
  const w = '<div style="padding-top:22px">' + h + '</div>';
  if (el.dataset.h !== w) { el.innerHTML = w; el.dataset.h = w; }
}
function mpDiv() {
  let el = document.getElementById('riderPed');
  if (!el) { el = document.createElement('div'); el.id = 'riderPed'; el.hidden = true; const ref = document.getElementById('riderWallet'); ref.parentNode.insertBefore(el, ref); }
  return el;
}
const APP_V = '23-oct-2026 · 23';
function renderPerfil(el) {
  const dot = document.getElementById('gDot'); if (dot) dot.classList.toggle('off', !S.online);
  let opts = 0; try { const i = window.__gmInfo && window.__gmInfo(); opts = i && i.opts ? i.opts.length : 0; } catch (e) {}
  const rno = (S.myAprob && S.myAprob.repNo ? 'R-' + String(S.myAprob.repNo).padStart(3, '0') : '');
  const av = '<div class="pf-card"><label class="pf-pic" aria-label="Cambiar mi foto">' + (S.myThumb ? '<img alt="Mi foto" src="' + S.myThumb + '">' : '<span class="pf-ph"><svg viewBox="0 0 24 24" width="44" height="44" fill="#9aa3ad"><circle cx="12" cy="8" r="4.2"/><path d="M3.5 21c0-4.6 3.8-7.5 8.5-7.5s8.5 2.9 8.5 7.5z"/></svg></span>') + '<span class="pf-cam"><svg viewBox="0 0 24 24" width="18" height="18" fill="#fff"><path d="M9 4 7.6 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2.6L15 4zm3 4.5A4.5 4.5 0 1 1 12 17.5a4.5 4.5 0 0 1 0-9z"/></svg></span><input class="sr" type="file" accept="image/*" capture="user" data-pfoto="1"></label>' +
    '<div class="pf-nm">' + esc(S.name || 'Repartidor') + '</div>' + (rno ? '<div class="pf-no"><small>Número de repartidor</small><b>' + esc(rno) + '</b></div>' : '') +
    (S.myThumb ? '' : '<div class="pf-hint">Toca el círculo para subir tu selfie</div>') + '</div>';
  const h = av + pfRow('pf-dark', 'moon', 'Modo oscuro', isDarkNow() ? 'on' : 'off') + pfRow('pf-notif', 'bell', 'Notificaciones', notifOn() ? 'on' : 'off') +
    pfRow('pf-pass', 'lock', 'Cambiar contraseña') + (recEligible() ? pfRow('pf-rec', 'mail', 'Correo de recuperación') : '') + pfRow('pf-terms', 'list', 'Términos y condiciones') + pfRow('pf-priv', 'shield', 'Política de privacidad') +
    (opts ? pfRow('pf-switch', 'swap', 'Cambiar de perfil') : '') + '<button type="button" class="pf-row" data-act="signout" id="pfOut"><span class="pf-i">' + PI.out + '</span><span class="pf-l">Cerrar sesión</span></button><p class="pf-ver">Versión ' + APP_V + '</p>';
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
function pfOverlay(html) {
  let ov = document.getElementById('pfOv');
  if (!ov) { ov = document.createElement('div'); ov.id = 'pfOv'; document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target.closest('[data-pf=close]') || e.target === ov) ov.hidden = true; });
    ov.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target; if (f.id !== 'pfPassForm') return;
      const er = f.querySelector('.pf-er'), cur = f.cur.value, n1 = f.n1.value, n2 = f.n2.value;
      const fail = (m) => { er.textContent = m; };
      if (!cur) return fail('Escribe tu contraseña actual.');
      if (n1.length < 6) return fail('La nueva debe tener mínimo 6 caracteres.');
      if (n1 !== n2) return fail('Las contraseñas nuevas no son iguales.');
      if (n1 === cur) return fail('La nueva debe ser distinta a la actual.');
      const b = f.querySelector('button[type=submit]'); b.disabled = true; er.textContent = '';
      try {
        const u = auth.currentUser; await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, cur)); await updatePassword(u, n1);
        if (S.pwFor === S.email) S.pw = n1; ov.hidden = true; toast('Contraseña cambiada ✓');
      } catch (x) { const c = (x && x.code) || ''; fail(/wrong-password|invalid-credential|invalid-login/.test(c) ? 'Tu contraseña actual no es correcta.' : /too-many/.test(c) ? 'Muchos intentos. Espera unos minutos.' : /network/.test(c) ? 'Sin internet. Intenta de nuevo.' : 'No se pudo cambiar. Intenta de nuevo.'); b.disabled = false; }
    });
  }
  ov.innerHTML = html; ov.hidden = false; return ov;
}
function pfText(title, txt) {
  pfOverlay('<div class="pf-box"><div class="pf-bar"><b>' + esc(title) + '</b><button type="button" data-pf="close" class="pf-x">Cerrar</button></div><div class="reg pf-doc">' + regHtml(txt) + '</div></div>');
}
function pfPass() {
  const eye = '<button type="button" class="pf-eye" tabindex="-1" aria-label="Ver" onclick="var i=this.previousElementSibling;i.type=i.type===\'password\'?\'text\':\'password\'">👁</button>';
  pfOverlay('<form class="pf-box pf-form" id="pfPassForm" autocomplete="off"><div class="pf-bar"><b>Cambiar contraseña</b><button type="button" data-pf="close" class="pf-x">Cerrar</button></div>' +
    '<label>Contraseña actual<span class="pf-f"><input name="cur" type="password" autocomplete="current-password">' + eye + '</span></label>' +
    '<label>Contraseña nueva<span class="pf-f"><input name="n1" type="password" autocomplete="new-password">' + eye + '</span></label>' +
    '<label>Repite la nueva<span class="pf-f"><input name="n2" type="password" autocomplete="new-password">' + eye + '</span></label>' +
    '<p class="pf-er" role="alert"></p><button type="submit" class="btn primary block">Guardar contraseña</button></form>');
}
(function () { try { const t = localStorage.getItem('gasca_theme'); if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); } catch (e) {} })();
(function () { try { const r = new URLSearchParams(location.search).get('ref'); if (r && /^\d{1,5}$/.test(r)) localStorage.setItem('gasca_ref', r); } catch (e) {} })();
const BONO_C = 5000;
function myRepNo() { return (S.myAprob && S.myAprob.repNo) || 0; }
function appLink() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function openShare() {
  let ov = document.getElementById('shareOv');
  if (!ov) { ov = document.createElement('div'); ov.id = 'shareOv'; document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov || (e.target.closest && e.target.closest('[data-sh=close]'))) ov.hidden = true; }); }
  const link = appLink() + (myRepNo() ? '?ref=' + myRepNo() : '');
  const msg = 'Hola 👋 Te invito a trabajar como repartidor en Gasca, entregas certificadas en Tepic 🛵. Instala la app aquí: ' + link;
  const WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.2 14.8l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 0 1 12 4z"/><path d="M8.6 7.5c-.3 0-.6.2-.8.5-.6.8-.7 2 .2 3.4 1.2 2 3 3.3 4.8 3.9 1.2.4 2.1.1 2.6-.7.2-.4.3-.9.2-1l-1.800-.9c-.2-.1-.4 0-.5.1l-.6.8c-.1.1-.3.2-.5.1-1-.4-1.900-1.200-2.400-2.200-.1-.2 0-.4.1-.5l.5-.6c.1-.2.1-.4 0-.6L9.200 7.900c-.1-.3-.3-.4-.6-.4z"/></svg>';
  const draw = () => {
    let qr = '';
    if (window.qrcode) { try { qr = qrSvg(link); } catch (e) { qr = ''; } }
    ov.innerHTML = '<div class="sh"><button type="button" class="shx" data-sh="close" aria-label="Cerrar">×</button><h2>Comparte la aplicación con amigos</h2><p>Comparte la aplicación con tus amigos repartidores</p>' +
      '<div class="shq">' + (qr || '<small>' + (S.qrFail ? 'No se pudo generar el QR. Usa el botón de WhatsApp.' : 'Generando QR…') + '</small>') + '</div><div class="shl">' + esc(link) + '</div>' +
      '<a class="shw" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(msg) + '">' + WA + 'Compartir por WhatsApp</a></div>';
  };
  draw(); ov.hidden = false;
  if (!window.qrcode) loadQR((ok) => { S.qrFail = !ok; if (!ov.hidden) draw(); });
}
function secPill() {
  const t = { disp: ['share', 'Invitar amigos'], perfil: ['user', 'Mi perfil'], viajes: ['moto', 'Mi resumen'], saldo: ['bag', 'Mis pedidos'], resumen: ['notes', 'En curso'] }[S.tab];
  let el = document.getElementById('secPill');
  if (!el) { el = document.createElement('div'); el.id = 'secPill'; el.hidden = true; const hd = document.querySelector('header.top'); if (hd) hd.appendChild(el); }
  const on = !!t && view() === 'rider';
  el.hidden = !on; if (on) { if (S.tab === 'disp') { el.setAttribute('data-act', 'share-open'); el.setAttribute('role', 'button'); } else { el.removeAttribute('data-act'); el.removeAttribute('role'); } const h = '<i>' + TI[t[0]] + '</i><b>' + esc(t[1]) + '</b>'; if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } }
}
function renderRider() {
  const open = S.orders.filter((o) => o.estado === 'abierto').sort((a, b) => (a.creadoEn || 0) - (b.creadoEn || 0));
  const my = mine();
  const active = my.filter((o) => o.estado === 'asignado' || o.estado === 'recogido').sort((a, b) => (b.asignadoEn || 0) - (a.asignadoEn || 0));
  const done = my.filter((o) => o.estado === 'entregado').sort((a, b) => (b.entregadoEn || 0) - (a.entregadoEn || 0));
  const doneToday = done.filter((o) => isToday(o.entregadoEn || o.creadoEn));
  const earned = doneToday.reduce((s, o) => s + (Number(o.tarifa) || 0), 0);

  $('#riderHead').innerHTML =
    '<button type="button" class="switch" role="switch" id="onlineSw0" aria-checked="' + (S.online ? 'true' : 'false') + '" data-act="online">' +
    '<span class="track" aria-hidden="true"></span><span><strong>' + (S.online ? 'En línea' : 'Desconectado') + '</strong>' +
    '<span class="sub">' + (S.online ? 'Deja Gasca abierta y la pantalla encendida para recibir avisos.' : 'Conéctate para recibir avisos de pedidos nuevos.') + '</span></span></button>' +
    (S.walletReady && saldoC() < 2000 ? '<p class="warn">Saldo bajo. Recarga para seguir aceptando pedidos.</p>' : '');

  const av = $('#riderAvail'), tr = $('#riderTrips');
  av.hidden = S.tab !== 'disp'; tr.hidden = S.tab !== 'viajes';
  const sm = $('#riderSum'); sm.hidden = S.tab !== 'resumen';
  if (S.tab === 'resumen') renderEnCurso(sm, active.slice().reverse());
  { const pf = pfDiv(); pf.hidden = S.tab !== 'perfil'; $('#riderHead').hidden = ['perfil', 'viajes', 'saldo', 'resumen', 'disp'].includes(S.tab); document.body.classList.toggle('pf-on', ['perfil', 'viajes', 'saldo', 'resumen', 'disp'].includes(S.tab)); if (!pf.hidden) renderPerfil(pf); }
  { const mp = mpDiv(); mp.hidden = S.tab !== 'saldo'; if (!mp.hidden) renderMisPedidos(mp, my); }
  { const showW = S.tab === 'saldo' && (S.rechargeOpen || S.recargas.some((r) => r.estado !== 'confirmada')); /* Saldo: limpia; solo se ve al recargar o con una recarga pendiente */
    $('#riderWallet').hidden = !showW; if (showW) renderWallet(); }
  if (S.tab === 'disp') {
    const far = S.online ? S.openOrders.filter(liveR).filter((x) => !inMyZone(x)) : [];
    const lowS = S.online && S.walletReady && S.openOrders.filter(liveR).some((x) => !canTake(x));
    const hint = (lowS ? '<p class="warn">Tu saldo no alcanza para algunos pedidos. Recarga en la motito.</p>' : '') + (far.length ? '<p class="warn">Hay ' + far.length + (far.length === 1 ? ' pedido abierto' : ' pedidos abiertos') + ' que no te quedan cerca (a más de ' + (S.radioKm || 3) + ' km) o aún no se ubica su dirección.</p>' : '');
    av.innerHTML = !S.openReady ? '' : hint + (open.length ? '<div class="subhead">Pedidos disponibles (' + open.length + ')</div>' + open.map(availCard).join('') : '');
  }
  try { renderSheet(); } catch (e) {}
  try { window.__mapSync && window.__mapSync({ offer: S.sheetId ? byId(S.sheetId) : null, active, act0: active.length ? active[active.length - 1] : null, done, doneToday }); } catch (e) { console.warn('mapa', e); }
  if (S.tab === 'viajes') {
    const wk = new Date(); wk.setHours(0, 0, 0, 0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7));
    const nWeek = done.filter((o) => (o.entregadoEn || o.creadoEn || 0) >= wk.getTime()).length;
    const fecha = new Date().toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/[.,]/g, '').replace(/^./, (c) => c.toUpperCase());
    const low = S.walletReady && saldoC() < 2000;
    let h = '<div class="vj-date" style="padding-top:0">' + esc(fecha) + '</div>' +
      '<div class="vj-3"><div><b>' + doneToday.length + '</b><small>Entregas hoy</small></div><div><b>' + nWeek + '</b><small>Entregas de la semana</small></div><div><b>' + done.length + '</b><small>Totales</small></div></div>' +
      '<div class="vj-dia"><b class="vj-dt">Ganancias de hoy</b><div><span><small>Ganancia neta</small><b>' + m2(doneToday.reduce((t, o) => t + (Number(o.tarifa) || 0) - comC(o) / 100, 0)) + '</b></span><span><small>Comisión retenida</small><b class="vj-ret">' + m2(doneToday.reduce((t, o) => t + comC(o) / 100, 0)) + '</b></span></div></div>' +
      '<div class="vj-saldo' + (low ? ' low' : '') + '"><small>Saldo disponible</small><b>' + (S.walletReady ? cents(saldoC()) : '…') + '</b>' + (low ? '<span>Saldo bajo. Recarga para seguir aceptando pedidos.</span>' : '') + '<button class="btn primary block" type="button" data-act="vj-recharge">Recargar saldo</button></div>';
    if (active.length) h += '<div class="subhead">Viaje en curso</div>' + active.map(tripCard).join('');
    tr.innerHTML = h;
  }
  return [{ id: 'disp', label: 'Pedidos', badge: open.length, icon: 'home' }, { id: 'resumen', label: 'Mi día', icon: 'notes' }, { id: 'saldo', label: 'Saldo', icon: 'bag' }, { id: 'viajes', label: 'Mis viajes', badge: active.length, icon: 'moto' }, { id: 'perfil', label: 'Perfil', icon: 'user' }];
}

function movRow(m) {
  const plus = m.montoC >= 0;
  const lbl = m.tipo === 'prueba' ? 'Saldo de prueba' : m.tipo === 'recarga' ? 'Recarga' : m.tipo === 'bono' ? 'Bono por recomendación' : 'Comisión ' + (m.orderId ? folio(m.orderId) : '');
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

function cambioCard(c) {
  const u = S.users.find((x) => x.id === c.uid) || {}, busy = S.busy.has('cp' + c.uid);
  const ln = (k, a, b) => (a || '') === (b || '') ? '' : '<div class="line"><span class="k">' + k + '</span><span class="v">' + esc(a || '—') + ' → <b>' + esc(b) + '</b></span></div>';
  return '<article class="order"><div class="head"><span class="folio">' + esc(repTag(c.uid) + (u.name || c.name)) + '</span><span class="chip abierto">Cambio de perfil</span><span class="ago">' + ago(c.creadoEn) + '</span></div>' +
    ln('Nombre', u.name, c.name) + ln('Dirección', u.addr, c.addr) + ln('Teléfono', u.tel, c.tel) +
    (c.tel ? '<div class="line"><span class="k">Para confirmar</span><span class="v"><b>' + esc(c.tel) + '</b></span></div><div class="links"><a href="' + esc(waUrl(c.tel)) + '" target="_blank" rel="noopener">💬 WhatsApp</a><a href="tel:' + esc(c.tel) + '">📞 Llamar</a></div>' : '<p class="hint">Este negocio no mandó teléfono.</p>') +
    (u.tel && u.tel !== c.tel ? '<div class="line"><span class="k">Teléfono anterior</span><span class="v">' + esc(u.tel) + '</span></div><div class="links"><a href="' + esc(waUrl(u.tel)) + '" target="_blank" rel="noopener">💬 WhatsApp al anterior</a></div>' : '') +
    '<div class="field"><label for="cp-motivo-' + esc(c.uid) + '">Motivo si lo rechazas</label><input id="cp-motivo-' + esc(c.uid) + '" type="text" maxlength="160" placeholder="Ej. La dirección no coincide con tu local"></div>' +
    '<div class="actions"><button class="btn danger small" type="button" data-act="cp-no" data-id="' + esc(c.uid) + '"' + (busy ? ' disabled' : '') + '>Rechazar</button>' +
    '<button class="btn primary small" type="button" data-act="cp-ok" data-id="' + esc(c.uid) + '"' + (busy ? ' disabled' : '') + '>Aprobar</button></div></article>';
}
async function resolveCambio(id, ok) {
  const k = 'cp' + id, c = (S.cambios || []).find((x) => x.uid === id);
  if (!S.isAdmin || !c || S.busy.has(k)) return;
  S.busy.add(k); render();
  try {
    if (ok) {
      await updateDoc(doc(db, 'users', id), { name: c.name, addr: c.addr, tel: c.tel || '' });
      await updateDoc(doc(db, 'cambiosPerfil', id), { estado: 'aprobado', en: Date.now() });
      toast('Cambios aprobados.');
    } else {
      const m = ((document.getElementById('cp-motivo-' + id) || {}).value || '').trim().slice(0, 160);
      await updateDoc(doc(db, 'cambiosPerfil', id), { estado: 'rechazado', motivo: m, en: Date.now() });
      toast('Cambios rechazados.');
    }
  } catch (e) { toast('No se pudo guardar. Intenta de nuevo.'); }
  S.busy.delete(k); render();
}
function altaCard(u) {
  const slots = slotsFor(u), open = S.review === u.id, busy = S.busy.has('al' + u.id);
  const n = Array.isArray(u.fotos) ? u.fotos.length : 0;
  let h = '<article class="order"><div class="head"><span class="folio">' + esc(repTag(u.id) + u.name) + '</span><span class="chip abierto">' + esc(roleLbl(u)) + '</span><span class="ago">' + ago(u.docsEn) + '</span></div>' +
    bajaLine(u.id) + (u.role === 'shop' && u.addr ? '<div class="line"><span class="k">Dirección</span><span class="v">' + esc(u.addr) + '</span></div>' : '') +
    (u.role === 'rider' && /^Tel \d{10}$/.test(u.addr || '') ? '<div class="line"><span class="k">Teléfono</span><span class="v"><b>' + esc(u.addr.slice(4)) + '</b></span></div><div class="links"><a href="' + esc(waUrl(u.addr.slice(4))) + '" target="_blank" rel="noopener">💬 WhatsApp</a><a href="tel:' + esc(u.addr.slice(4)) + '">📞 Llamar</a></div>' : '') +
    '<div class="line"><span class="k">Fotos enviadas</span><span class="v">' + n + ' de ' + slots.length + '</span></div>' +
    ('<div class="line"><span class="k">' + (u.role === 'rider' ? 'Reglamento' : 'Aviso de privacidad') + '</span><span class="v">' + (u.reglamentoEn ? 'Aceptado v' + esc(u.reglamentoV || '') + ' · ' + new Date(u.reglamentoEn).toLocaleString('es-MX') : 'No lo ha aceptado') + '</span></div>');
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
function delConfirm(u) {
  const w = S.wallets[u.id], c = w && (w.saldoC || 0);
  return '<p class="hint"><b>¿Eliminar a ' + esc(u.name) + '?</b> Ya no podrá entrar a la app.' + (c > 0 ? ' Tiene saldo de ' + cents(c) + ': devuélveselo antes.' : '') + '</p><div class="actions"><button class="btn ghost small" type="button" data-act="del-no">Conservar</button><button class="btn danger small" type="button" data-act="del-yes" data-id="' + esc(u.id) + '">Sí, eliminar</button></div>';
}
async function setBaja(id, baja) {
  const k = 'bj' + id;
  if (!S.isAdmin || S.busy.has(k)) return;
  S.busy.add(k); render();
  try {
    const prev = S.aprobs[id] || {};
    const data = { id, estado: baja ? 'eliminado' : 'rechazado', motivo: baja ? 'Cuenta eliminada por la administración.' : 'Cuenta restaurada: vuelve a enviar tus documentos.', en: Date.now(), por: S.uid };
    if (prev.repNo) data.repNo = prev.repNo;
    data.bajas = (prev.bajas || 0) + (baja ? 1 : 0); data.bajaEn = baja ? Date.now() : (prev.bajaEn || 0);
    if (!data.bajas) { delete data.bajas; delete data.bajaEn; }
    await setDoc(doc(db, 'aprobaciones', id), data);
    S.delId = null; S.suspId = null;
    toast(baja ? 'Usuario eliminado.' : 'Usuario restaurado.');
  } catch (e) { toast('No se pudo guardar. Intenta de nuevo.'); }
  S.busy.delete(k); render();
}
function renderAltas() {
  const el = $('#adminAltas');
  if (document.activeElement && /^(a-motivo|cp-motivo)/.test(document.activeElement.id || '')) return;
  const all = S.users.map((u) => ({ u, st: personStatus(u, S.aprobs[u.id]) }));
  const rev = all.filter((x) => x.st === 'revision').sort((a, b) => (a.u.docsEn || 0) - (b.u.docsEn || 0));
  const apr = all.filter((x) => x.st === 'aprobado');
  const oth = all.filter((x) => x.st === 'incompleto' || x.st === 'rechazado');
  const cps = (S.cambios || []).filter((c) => c.estado === 'pendiente').sort((a, b) => (a.creadoEn || 0) - (b.creadoEn || 0));
  let h = '<h2 class="section">Altas</h2>' + (cps.length ? '<div class="subhead">Cambios de perfil por aprobar (' + cps.length + ')</div>' + cps.map(cambioCard).join('') : '') + '<div class="subhead">Por revisar (' + rev.length + ')</div>';
  h += rev.length ? rev.map((x) => altaCard(x.u)).join('') : '<p class="hint">Nadie está esperando aprobación.</p>';
  h += '<div class="subhead">Aprobados (' + apr.length + ')</div>';
  h += apr.length ? apr.map((x) => {
    const u = x.u, a = S.aprobs[u.id] || {};
    return '<div class="pr"><div class="t"><b>' + esc(repTag(u.id) + u.name) + '</b><span class="chip entregado">Aprobado</span></div><small>' + esc(roleLbl(u)) + ' · aprobado ' + ago(a.en || u.creadoEn) + '</small>' + bajaLine(u.id) +
      (S.suspId === u.id
        ? '<div class="actions"><button class="btn ghost small" type="button" data-act="susp-no">Conservar</button><button class="btn danger small" type="button" data-act="susp-yes" data-id="' + esc(u.id) + '">Sí, suspender</button></div>'
        : S.delId === u.id ? delConfirm(u)
        : '<div class="actions"><button class="btn ghost small" type="button" data-act="susp" data-id="' + esc(u.id) + '">Suspender</button><button class="btn danger small" type="button" data-act="del" data-id="' + esc(u.id) + '">Eliminar</button></div>') + '</div>';
  }).join('') : '<p class="hint">Todavía no has aprobado a nadie.</p>';
  if (oth.length) {
    h += '<div class="subhead">Sin enviar o rechazados (' + oth.length + ')</div>' + oth.map((x) => {
      const a = S.aprobs[x.u.id];
      return prRow(x.u.name, verLabel(x.st), '', esc(roleLbl(x.u)) + (x.st === 'rechazado' && a && a.motivo ? ' · ' + esc(a.motivo) : '') + ' · se unió ' + ago(x.u.creadoEn)).replace(/<\/div>$/, S.delId === x.u.id ? delConfirm(x.u) + '</div>' : '<div class="actions"><button class="btn danger small" type="button" data-act="del" data-id="' + esc(x.u.id) + '">Eliminar</button></div></div>');
    }).join('');
  }
  const gone = all.filter((x) => x.st === 'eliminado');
  if (gone.length) {
    h += '<div class="subhead">Eliminados (' + gone.length + ')</div>' + gone.map((x) => '<div class="pr"><div class="t"><b>' + esc(repTag(x.u.id) + x.u.name) + '</b><span class="chip cancelado">Eliminado</span></div><small>' + esc(roleLbl(x.u)) + ' · ' + ago((S.aprobs[x.u.id] || {}).en) + '</small><div class="actions"><button class="btn ghost small" type="button" data-act="undel" data-id="' + esc(x.u.id) + '">Restaurar</button></div></div>').join('');
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
  if (S.isAgent && S.tab !== 'inicio' && ['monitor', 'pedidos', 'incidencias'].indexOf(S.tab) < 0) S.tab = 'inicio';
  const sp = spDiv(); sp.hidden = S.tab !== 'soporte' || S.isAgent; if (!sp.hidden) renderSoporte(sp);
  const pd = pedDiv(); pd.hidden = S.tab !== 'pedidos'; if (S.tab === 'pedidos') renderPedidos(pd);
  const ic = incDiv(); ic.hidden = S.tab !== 'incidencias';
  if (S.tab === 'incidencias') renderIncid(ic);
  if (S.tab === 'monitor') renderMonitor();
  if (S.tab === 'altas') renderAltas();
  if (S.tab === 'ajustes' && !S.pagoDirty && document.activeElement !== $('#a-pago')) $('#a-pago').value = S.pago;
  if (S.tab === 'recargas') {
    const q = normCode($('#a-buscar').value);
    const shown = q ? S.recargas.filter((r) => normCode(r.codigo).indexOf(q) >= 0).sort((a, b) => b.creadoEn - a.creadoEn) : pend;
    let h = (q || S.isAgent ? '' : bonosHtml()) + '<h2 class="section">' + (q ? 'Resultado de la búsqueda' : 'Recargas por confirmar') + '</h2>';
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
    const pr = S.pruebas || {}, real = (m) => !pr[m.driverId];
    const ids = Object.keys(S.wallets).sort((a, b) => (S.wallets[b].saldoC || 0) - (S.wallets[a].saldoC || 0));
    const com = S.movs.filter((m) => m.tipo === 'comision' && real(m)).reduce((s, m) => s - m.montoC, 0);
    const rec = S.movs.filter((m) => m.tipo === 'recarga' && real(m)).reduce((s, m) => s + m.montoC, 0);
    let t = '<h2 class="section">Saldos</h2><div class="rider-head"><div class="today"><div><b>' + cents(com) + '</b><small>Comisiones</small></div><div><b>' + cents(rec) + '</b><small>Recargado</small></div></div></div>';
    t += ids.length ? '<div>' + ids.map((id) => '<div class="sv-row"><span>' + esc(nm[id] || 'Repartidor') + (pr[id] ? ' 🧪 <small>prueba</small>' + ((S.wallets[id].saldoC || 0) ? ' <button class="btn ghost small" type="button" data-act="pr-zero" data-id="' + esc(id) + '"' + (S.busy.has('pr0' + id) ? ' disabled' : '') + '>Poner en $0</button>' : '') : '') + '</span><b class="' + ((S.wallets[id].saldoC || 0) <= 0 ? 'neg' : '') + '">' + cents(S.wallets[id].saldoC) + '</b></div>').join('') + '</div>'
      : emptyBox('Sin repartidores todavía', 'Aquí ves el saldo de cada repartidor cuando recargue o entregue su primer pedido.');
    if (!S.isAgent) {
      const riders = S.users.filter((u) => u.role === 'rider').sort((a, b) => String(a.name).localeCompare(String(b.name)));
      t += '<div class="paynote" id="prBox"><b>🧪 Saldo de prueba</b><br>Para probar la app con una cuenta de repartidor. Este saldo <b>no se cuenta</b> en Comisiones ni en Recargado, ni lo que se descuente a esa cuenta después.' +
        '<div class="field" style="margin-top:8px"><label for="pr-rider">Repartidor</label><select id="pr-rider"><option value="">Elige un repartidor</option>' + riders.map((u) => '<option value="' + esc(u.id) + '"' + (S.prRider === u.id ? ' selected' : '') + '>' + esc(repTag(u.id) + u.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="pr-monto">Monto de prueba</label><input id="pr-monto" type="number" inputmode="decimal" min="1" max="5000" placeholder="$ cuánto saldo de prueba" value="' + esc(S.prMonto || '') + '"></div>' +
        '<button class="btn primary block" type="button" data-act="pr-set"' + (S.busy.has('pr') ? ' disabled' : '') + '>' + (S.busy.has('pr') ? 'Poniendo…' : 'Poner saldo de prueba') + '</button></div>';
    }
    const ae = document.activeElement;
    if (!(ae && sd.contains(ae) && /^(INPUT|SELECT)$/.test(ae.tagName))) sd.innerHTML = t;
  }
  const all = [
    { id: 'monitor', label: 'En vivo', badge: S.orders.filter((o) => o.estado === 'abierto').length },
    { id: 'altas', label: 'Altas', badge: S.users.filter((u) => personStatus(u, S.aprobs[u.id]) === 'revision').length + (S.cambios || []).filter((c) => c.estado === 'pendiente').length },
    { id: 'recargas', label: 'Recargas', badge: pend.length },
    { id: 'pedidos', label: 'Pedidos', badge: S.orders.filter((o) => o.estado === 'asignado' || o.estado === 'recogido').length },
    { id: 'incidencias', label: 'Incidencias', badge: S.incs.filter((x) => x.estado === 'abierta').length },
    { id: 'saldos', label: 'Saldos' },
    { id: 'soporte', label: 'Soporte', badge: 0 },
    { id: 'zonas', label: 'Radio' },
    { id: 'ajustes', label: 'Depósito' }
  ];
  return S.isAgent ? all.filter((t) => t.id === 'monitor' || t.id === 'pedidos' || t.id === 'incidencias') : all;
}

function whoSet(t) { const n = document.getElementById('whoName'); if (n && n.textContent !== t) n.textContent = t; }
const TI = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.2 2.4 11.6c-.5.4-.2 1.2.5 1.2H5V20a1 1 0 0 0 1 1h4v-5.5h4V21h4a1 1 0 0 0 1-1v-7.2h2.1c.7 0 1-.8.5-1.2z"/></svg>',
  notes: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2.2 4.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm3.6.2a.9.9 0 0 0 0 1.8h5.4a.9.9 0 0 0 0-1.8zM7.2 10.9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm3.6.2a.9.9 0 0 0 0 1.8h5.4a.9.9 0 0 0 0-1.8zm-3.6 3.7a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm3.6.2a.9.9 0 0 0 0 1.8h5.4a.9.9 0 0 0 0-1.8z"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 7V6a4 4 0 0 1 8 0v1h2.2a1 1 0 0 1 1 .9l1 12A1 1 0 0 1 19.2 21H4.8a1 1 0 0 1-1-1.1l1-12a1 1 0 0 1 1-.9zm2 0h4V6a2 2 0 0 0-4 0zm-.5 3.2a1 1 0 0 0 0 2 1 1 0 0 0 0-2zm5 0a1 1 0 0 0 0 2 1 1 0 0 0 0-2z"/></svg>',
  moto: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 6.2c0-.6.4-1 1-1h3c.6 0 1 .4 1 1s-.4 1-1 1H4c-.6 0-1-.4-1-1zM6.4 9.2h3.7l1.9 4.6h2.2l-1.2-3.5c-.2-.7.3-1.3 1-1.3h1.1c.5 0 .9.3 1.1.7l2 4.8a3.4 3.4 0 1 1-1.9.8l-.3-.7h-2.4c-.5 0-.9-.3-1.1-.7L9.5 11H7.7c-1.6 0-2.9 1.2-3.1 2.8l-.2 1.7H6a3.5 3.5 0 1 1-3.5 4.1.7.7 0 0 1 0-.2V15c0-3.4 1.6-5.8 3.9-5.8zM5.2 20.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zm13.5 0a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 16.1c-.8 0-1.5.3-2 .8L8.9 12.7c.1-.2.1-.5.1-.7s0-.5-.1-.7L15.9 9.2c.5.5 1.2.8 2.1.8a3 3 0 1 0-3-3c0 .2 0 .5.1.7L8 11.8a3 3 0 1 0 0 4.4l7.1 4.2c-.1.2-.1.5-.1.7a2.9 2.9 0 1 0 3-3z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="7.8" r="4.3"/><path d="M3.6 20.2c0-4 3.8-6.3 8.4-6.3s8.4 2.3 8.4 6.3c0 .5-.4.8-.8.8H4.4c-.4 0-.8-.3-.8-.8z"/></svg>'
};
(function () {
  const bt = document.querySelector('.brand .bt'); if (bt && !document.getElementById('gDot')) { const d = document.createElement('span'); d.id = 'gDot'; const bn = bt.querySelector('.brandname'); bn.appendChild(d); }
  const st = document.createElement('style');
  st.textContent = '#gDot{display:none;width:12px;height:12px;border-radius:50%;background:#1fa855;margin-left:9px;vertical-align:middle;box-shadow:0 0 0 3px rgba(31,168,85,.22)}#gDot.off{background:#d33;box-shadow:0 0 0 3px rgba(211,51,51,.22)}#gDot{}.pf-on #gDot{display:inline-block}.pf-on #whoName{display:none!important}.pf-on .top{position:sticky;top:0;z-index:20;background:var(--bg);padding-bottom:8px}' +
    '#riderPed{padding-top:14px}.mp-title{text-align:center;font-size:21px;font-weight:600;margin:6px 0 14px}.mp-sub{font-size:20px;font-weight:800;margin:0 2px 12px}.mp-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);line-height:1.35}.mp-top{display:flex;justify-content:space-between;gap:10px;font-size:19px}.mp-top span{font-weight:800;font-size:17px;white-space:nowrap}.mp-sol{font-size:16.5px;margin-top:2px}.mp-fh{font-size:16.5px;color:var(--muted)}.mp-dir{font-size:17px;margin-top:2px}.mp-money{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:2px;font-size:17px}.mp-money b{color:var(--green)}.mp-go{cursor:pointer}.mp-hint{margin-top:10px;font-size:13.5px;color:var(--muted)}.vj-date{text-align:right;font-weight:700;font-size:14px;opacity:.75;padding:22px 2px 10px}.vj-3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.vj-3>div,.vj-saldo{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}.vj-3>div{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:8px;padding:16px 4px;text-align:center}.vj-3>div small{min-height:34px;display:flex;align-items:flex-start;justify-content:center}.vj-3 b{font-size:34px;line-height:1}.vj-3 small,.vj-saldo small{font-size:13px;font-weight:700;opacity:.7}.vj-dia{margin-top:14px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px 18px}.vj-dt{font-size:18px}.vj-dia>div{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.vj-dia span{display:flex;flex-direction:column;gap:4px}.vj-dia small{font-size:13px;font-weight:700;opacity:.7}.vj-dia span b{font-size:28px;line-height:1.1}.vj-dia .vj-ret{color:var(--muted)}.vj-saldo{margin-top:14px;margin-bottom:14px;padding:16px 18px;display:flex;flex-direction:column;gap:6px}.vj-saldo b{font-size:32px}.vj-saldo.low b,.vj-saldo span{color:var(--red)}.vj-saldo span{font-weight:700;font-size:14px}.vj-saldo .btn{margin-top:8px}#riderPerfil{gap:14px;padding-top:26px}.pf-row{display:flex;align-items:center;gap:16px;width:100%;min-height:62px;padding:12px 18px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:14px;font:inherit;font-size:17px;text-align:left;box-shadow:0 1px 3px rgba(0,0,0,.06)}.pf-row:active{background:var(--surface2)}.pf-i{flex:none;width:26px;height:26px;display:grid;place-items:center}.pf-i svg{width:24px;height:24px}.pf-l{flex:1}.pf-sw{flex:none;width:52px;height:30px;border-radius:99px;background:#c9ced4;position:relative;transition:background .15s}.pf-sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s}.pf-sw.on{background:#f8b980}.pf-sw.on i{background:#f08c00;transform:translateX(22px)}' +
    '#pfOv{position:fixed;inset:0;z-index:9500;background:var(--bg);overflow:auto}#pfOv[hidden]{display:none}.pf-box{max-width:520px;margin:0 auto;padding:0 16px 40px}.pf-bar{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg);padding:16px 0 10px;font-size:20px}.pf-x{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:12px;padding:8px 16px;font:inherit;font-weight:700}.pf-doc{max-height:none!important;overflow:visible!important}.pf-form label{display:block;margin-top:14px;font-weight:700}.pf-f{display:flex;margin-top:6px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.pf-f input{flex:1;min-width:0;border:0;background:none;color:var(--ink);font:inherit;font-size:17px;padding:13px 12px}.pf-eye{border:0;background:none;padding:0 14px;font-size:18px}.pf-er{color:var(--red);font-weight:700;min-height:22px;margin:10px 0}' +
    '.rider-bar #who{display:none!important}body.has-tabs main{padding-bottom:96px}' +
    '.tabs-in.ico{gap:0}.tabs-in.ico .tab{position:relative;min-height:56px;padding:0;background:none!important;color:#a3a3a3;border-radius:14px}.tabs-in.ico .tab svg{width:30px;height:30px}.tabs-in.ico .tab[aria-selected="true"]{color:#f08c00}.tabs-in.ico .tab:active{background:rgba(0,0,0,.05)!important}' +
    '.tabs-in.ico .badge{position:absolute;top:3px;left:calc(50% + 8px);min-width:19px;height:19px;font-size:11px;padding:0 5px;background:#e8452c!important;color:#fff!important}' +
    '.pf-top{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 0 4px}.pf-av{width:84px;height:84px;border-radius:50%;background:#f6b400;color:#16202a;display:grid;place-items:center}.pf-av svg{width:48px;height:48px}.pf-top b{font-size:24px;margin-top:6px}.pf-top small{font-size:15px;opacity:.7}';
  document.head.appendChild(st);
})();
function renderTabs(tabs) {
  const nav = $('#tabs'); nav.hidden = !tabs;
  if (!tabs) { document.body.classList.remove('has-tabs'); return; }
  $('#tabsIn').style.setProperty('--n', tabs.length);
  $('#tabsIn').setAttribute('data-n', tabs.length);
  const ico = !!tabs[0].icon;
  $('#tabsIn').classList.toggle('ico', ico); document.body.classList.toggle('has-tabs', true);
  $('#tabsIn').innerHTML = tabs.map((t) => ico
    ? '<button type="button" role="tab" class="tab" data-act="tab" data-tab="' + t.id + '" aria-label="' + esc(t.label) + '" title="' + esc(t.label) + '" aria-selected="' + (S.tab === t.id) + '">' + (TI[t.icon] || '') + (t.badge ? '<span class="badge">' + t.badge + '</span>' : '') + '</button>'
    : '<button type="button" role="tab" class="tab" data-act="tab" data-tab="' + t.id + '" aria-selected="' + (S.tab === t.id) + '">' + esc(t.label) +
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
  if (v === 'owner') { $('#ownerMail').textContent = 'Correo: ' + S.email; const ll = document.querySelector('#viewOwner .lede'); if (ll) ll.textContent = S.staffUnver ? 'Para entrar a soporte, abre el correo que te enviamos y toca el enlace de verificación. Revisa también la carpeta de spam.' : 'Para entrar como dueño, abre el correo que te enviamos y toca el enlace de verificación. Revisa también la carpeta de spam.'; }
  const who = $('#who');
  who.hidden = !S.user || v === 'loading';
  { const n0 = document.getElementById('whoName'); if (n0) n0.hidden = who.hidden; }
  { const hm = !!S.user && (v === 'shop' || v === 'rider'); who.classList.toggle('has-menu', hm); const lb = hm ? '☰ Menú' : 'Salir'; if (who.textContent !== lb) who.textContent = lb; }
  if (S.user) whoSet(v === 'admin' ? (S.isAgent ? 'Soporte · ' + S.agentName : 'Dueño') : (S.name ? (isCli(S.profile) ? 'Envío personal · ' : { shop: 'Tienda · ', rider: 'Repartidor · ' }[S.role] || '') + (S.role === 'rider' && S.myAprob && S.myAprob.repNo ? 'R-' + String(S.myAprob.repNo).padStart(3, '0') + ' · ' : '') + S.name : 'Salir'));
  renderBanner();
  try { ocSync(); } catch (e) { console.warn('orden', e); }
  try { secPill(); } catch (e) { console.warn('pill', e); }
  if (v !== 'shop') { const wd = document.getElementById('wzDone'); if (wd) wd.remove(); }
  if (v !== 'rider') { S.sheetId = null; if (!$('#sheet').hidden) { $('#sheet').hidden = true; S.sheetKey = ''; } }
  let tabs = null;
  if (v === 'verify') renderVerify();
  if (v === 'shop') tabs = renderShop();
  if (v === 'rider') tabs = renderRider();
  S.menuTabs = (v === 'shop' || v === 'rider') ? tabs : null;
  if (v === 'shop') tabs = null;
  document.body.classList.toggle('rider-bar', v === 'rider'); if (v !== 'rider') document.body.classList.remove('pf-on');
  if (v === 'admin') { const list = renderAdmin(); S.adminMenu = list; adminHome(list); tabs = null; }
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
    if (S.minOffer && tarifa < S.minOffer) { toast('Tu oferta debe ser de ' + pesos(S.minOffer) + ' o más.'); btn.disabled = false; btn.textContent = 'Pedir moto'; return; }
    cobro = Math.round((prod + (qp === 'r' ? tarifa : 0)) * 100) / 100;
    descTxt = descTxt.slice(0, 90) + DSEP + tp + '|' + prod + '|' + qp + '|' + ((document.querySelector('input[name=ceq]:checked') || {}).value || 'a');
  }
  const o = {
    shopId: S.uid, shop: S.name, pickup: isCli(S.profile) ? buildPick() : $('#o-pick').value.trim(), cliente: $('#o-cliente').value.trim(), tel: $('#o-tel').value.trim(),
    dest: buildDest(), desc: descTxt, cobro, tarifa
  };
  try {
    if (tarifa < 1 || tarifa > 2000) throw new Error('tarifa');
    const id = await createOrder(o);
    if (isCli(S.profile)) { saveDraft(id); S.minOffer = 0; }
    try { wzSave(); } catch (e2) {}
    ['o-cliente', 'o-tel', 'o-dest', 'o-calle', 'o-num', 'o-int', 'o-col', 'o-ref', 'o-desc', 'o-cobro'].forEach((i) => { $('#' + i).value = ''; });
    ['p-calle', 'p-col', 'o-prod'].forEach((i) => { $('#' + i).value = ''; }); cliSum();
    saveCity();
    S.tab = 'pedidos';
    toast('Pedido ' + folio(id) + ' enviado a los repartidores.');
    try { wzDone(id); } catch (e2) {}
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
  if (t.getAttribute('data-pfoto')) {
    const f = t.files && t.files[0]; t.value = '';
    if (f) uploadFoto('selfie', f);
  } else if (t.getAttribute('data-foto')) {
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
  else if (act === 'mode-login') { if (window.__LN) { window.__LN.on = true; if (window.__WC) window.__WC.on = false; } setMode('login'); }
  else if (act === 'mode-signup') { [...af.querySelectorAll('input[name=role]')].forEach((r) => { r.checked = false; }); setMode('signup'); }
  else if (act === 'mode-owner') { setMode('owner'); }
  else if (act === 'owner-create') ownerCreate();
  else if (act === 'owner-check') ownerCheck();
  else if (act === 'owner-resend') ownerResend();
  else if (act === 'reset') resetPass();
  else if (act === 'swr-open') { S.swr = true; S.swrRole = ''; S.swrName = (S.profile && S.profile.name) || ''; S.swrAddr = ''; S.swrTel = ''; render(); }
  else if (act === 'swr-close') { S.swr = false; render(); }
  else if (act === 'swr-pick') { S.swrRole = b.getAttribute('data-r'); render(); }
  else if (act === 'swr-go') switchRole();
  else if (act === 'pf-dark') { const d = !isDarkNow(); document.documentElement.setAttribute('data-theme', d ? 'dark' : 'light'); lsSet('gasca_theme', d ? 'dark' : 'light'); render(); }
  else if (act === 'pf-notif') {
    if (!('Notification' in window)) toast('Tu teléfono no permite notificaciones aquí.');
    else if (notifOn()) { lsSet('gasca_notif', '0'); render(); }
    else if (Notification.permission === 'denied') toast('Están bloqueadas. Actívalas en los ajustes del navegador.');
    else { lsSet('gasca_notif', '1'); Promise.resolve(Notification.requestPermission()).then(() => render()); }
  }
  else if (act === 'pf-pass') pfPass();
  else if (act === 'pf-rec') openRecovery();
  else if (act === 'pf-terms') pfText('Términos y condiciones', REG_TEXT.split('\n---\n')[0]);
  else if (act === 'pf-priv') pfText('Política de privacidad', REG_TEXT.split('\n---\n')[1] || PRIV_TEXT);
  else if (act === 'mp-more') { S.mpN = (S.mpN || 50) + 50; render(); }
  else if (act === 'pf-switch') { if (window.__gmOpen) window.__gmOpen(); }
  else if (act === 'ag-add') agAdd('ag');
  else if (act === 'sc-add') agAdd('sc', 'socio');
  else if (act === 'ag-qr') { const e2 = b.getAttribute('data-e'); S.qrFor = S.qrFor === e2 ? '' : e2; render(); }
  else if (act === 'ag-copy') { const l = agLink(b.getAttribute('data-e')); try { navigator.clipboard.writeText(l).then(() => toast('Enlace copiado.'), () => toast(l)); } catch (e) { toast(l); } }
  else if (act === 'ag-tog') agTog(b.getAttribute('data-e'));
  else if (act === 'ag-work') { S.incAg = b.getAttribute('data-e'); S.tab = 'incidencias'; render(); }
  else if (act === 'inc-ag') { S.incAg = b.getAttribute('data-e'); render(); }
  else if (act === 'ped-f') { S.pedF = b.getAttribute('data-f'); render(); }
  else if (act === 'tab') { S.tab = b.getAttribute('data-tab'); S.cancelId = null; render(); }
  else if (act === 'cancel') { S.cancelId = id; render(); }
  else if (act === 'cancel-no') { S.cancelId = null; render(); }
  else if (act === 'cancel-yes') cancelOrder(id);
  else if (act === 'wz-open') wzDone(id);
  else if (act === 'bn-ok') resolveBono(id, true);
  else if (act === 'bn-no') resolveBono(id, false);
  else if (act === 'share-open') openShare();
  else if (act === 'accept') { ensureAudio(); accept(id); }
  else if (act === 'counter') { ensureAudio(); counter(id, Number(b.getAttribute('data-m'))); }
  else if (act === 're-offer') reOffer(id);
  else if (act === 'of-yes') offerYes(b.getAttribute('data-oid'));
  else if (act === 'of-no') offerNo(b.getAttribute('data-oid'));
  else if (act === 'ignore') { S.ignored.add(id); S.queue = S.queue.filter((x) => x !== id); S.sheetId = null; clearTimeout(S.sheetT); syncSheet(); render(); }
  else if (act === 'vj-recharge') { S.tab = 'saldo'; S.rechargeOpen = true; S.cancelId = null; render(); window.scrollTo(0, 0); }
  else if (act === 'recharge-toggle') { S.rechargeOpen = !S.rechargeOpen; render(); }
  else if (act === 'amt') { $('#r-monto').value = b.getAttribute('data-v'); }
  else if (act === 'rc-ok') resolveRecarga(id, true);
  else if (act === 'pr-set') setPrueba();
  else if (act === 'pr-zero') zeroPrueba(id);
  else if (act === 'rc-no') resolveRecarga(id, false);
  else if (act === 'copy') copyCode(b.getAttribute('data-v'));
  else if (act === 'save-pago') savePago();
  else if (act === 'ver-edit') { S.verEdit = true; render(); }
  else if (act === 'ver-send') sendDocs();
  else if (act === 'rev-open') openReview(id);
  else if (act === 'rev-close') { S.review = null; S.revPhotos = null; S.motivo = ''; render(); }
  else if (act === 'cp-ok') resolveCambio(id, true);
  else if (act === 'cp-no') resolveCambio(id, false);
  else if (act === 'alta-ok') resolveAlta(id, true);
  else if (act === 'alta-no') resolveAlta(id, false, (S.motivo || '').trim());
  else if (act === 'susp') { S.suspId = id; render(); }
  else if (act === 'susp-no') { S.suspId = null; render(); }
  else if (act === 'del') { S.delId = id; S.suspId = null; render(); }
  else if (act === 'del-no') { S.delId = null; render(); }
  else if (act === 'del-yes') setBaja(id, true);
  else if (act === 'undel') setBaja(id, false);
  else if (act === 'susp-yes') resolveAlta(id, false, 'Cuenta suspendida por la administración.');
  else if (act === 'zoom') openZoom(b.getAttribute('src'));
  else if (act === 'oc-open') { S.oc = id; S.ocRo = false; render(); }
  else if (act === 'oc-ro') { S.oc = id; S.ocRo = true; render(); }
  else if (act === 'oc-close') { S.oc = null; S.ocRo = false; if (S.tab !== 'saldo') S.tab = 'disp'; render(); }
  else if (act === 'liberar') askLiberar(id);
  else if (act === 'ad-lib') adLiberar(id);
  else if (act === 'picked') picked(id);
  else if (act === 'delivered') askCode(id);
  else if (act === 'issue') askIssue(id);
  else if (act === 'noans') askNoAns(id);
  else if (act === 'libcode') askLib(id);
  else if (act === 'inc-code') incCode(id, b.getAttribute('data-oid'));
  else if (act === 'inc-release') incRelease(id, b.getAttribute('data-oid'));
  else if (act === 'inc-ok') incDone(id);
  else if (act === 'inc-reopen') incReopen(id, b.getAttribute('data-oid'));
  else if (act === 'inc-cancel') incCancel(id, b.getAttribute('data-oid'));
  else if (act === 'online') {
    S.online = !S.online; lsSet('gasca_online_' + S.uid, S.online ? '1' : '0');
    if (S.online) { ensureAudio(); beep([784]); queueOpen(); holdWake(); } else { S.queue = []; releaseWake(); }
    syncSheet(); render(); pushPresence();
  }
});

/* ---------- mapa de inicio (casita): mapa propio con OpenStreetMap, sin librerías de pago ---------- */
(function () {
  const TS = 256, TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', TEPIC = [21.5042, -104.8946];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const proj = (lat, lon, z) => { const s = TS * Math.pow(2, z), sl = Math.sin(clamp(lat, -85, 85) * Math.PI / 180); return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * s]; };
  const unproj = (x, y, z) => { const s = TS * Math.pow(2, z), n = Math.PI - 2 * Math.PI * y / s; return [180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), x / s * 360 - 180]; };

  class GMap {
    constructor(el) {
      this.el = el; this.z = 13; this.lat = TEPIC[0]; this.lon = TEPIC[1]; this.tiles = new Map(); this.mk = new Map(); this.rt = null; this.raf = 0; this.ptrs = new Map(); this.userMoved = () => {};
      el.innerHTML = '<div class="gm-tiles"></div><div class="gm-tint"></div><svg class="gm-svg"><path class="gm-rc"></path><path class="gm-rl"></path></svg><div class="gm-mk"></div>';
      this.tl = el.querySelector('.gm-tiles'); this.rc = el.querySelector('.gm-rc'); this.rl = el.querySelector('.gm-rl'); this.ml = el.querySelector('.gm-mk');
      this.bind();
    }
    size() { return [this.el.clientWidth || 300, this.el.clientHeight || 300]; }
    ctr() { return proj(this.lat, this.lon, this.z); }
    scr(lat, lon) { const s = this.size(), c = this.ctr(), p = proj(lat, lon, this.z); return [p[0] - c[0] + s[0] / 2, p[1] - c[1] + s[1] / 2]; }
    setView(lat, lon, z) { this.lat = clamp(lat, -85, 85); this.lon = lon; if (z != null) this.z = clamp(z, 3, 18); this.draw(); }
    panBy(dx, dy) { const c = this.ctr(), ll = unproj(c[0] - dx, c[1] - dy, this.z); this.lat = clamp(ll[0], -85, 85); this.lon = ll[1]; this.draw(); }
    zoomBy(dz) { this.z = clamp(this.z + dz, 3, 18); this.draw(); }
    fit(pts, pad) {
      if (!pts.length) return; const s = this.size(); pad = pad || {}; const t = pad.t || 70, b = pad.b || 190, l = pad.l || 40, r = pad.r || 40;
      const la = pts.map((p) => p[0]), lo = pts.map((p) => p[1]), a = [Math.min(...la), Math.min(...lo)], c = [Math.max(...la), Math.max(...lo)];
      let z = 18;
      for (; z > 3; z -= 0.5) { const p1 = proj(a[0], a[1], z), p2 = proj(c[0], c[1], z); if (Math.abs(p2[0] - p1[0]) <= s[0] - l - r && Math.abs(p2[1] - p1[1]) <= s[1] - t - b) break; }
      z = Math.min(z, 17);
      const p1 = proj(a[0], a[1], z), p2 = proj(c[0], c[1], z), mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const sx = (l + (s[0] - r)) / 2 - s[0] / 2, sy = (t + (s[1] - b)) / 2 - s[1] / 2, ll = unproj(mid[0] - sx, mid[1] - sy, z);
      this.setView(ll[0], ll[1], z);
    }
    setMarker(id, lat, lon, html, cls) {
      let m = this.mk.get(id);
      if (!m) { m = { el: document.createElement('div') }; m.el.className = 'gm-m ' + (cls || ''); m.el.innerHTML = html; this.ml.appendChild(m.el); this.mk.set(id, m); }
      m.lat = lat; m.lon = lon; this.draw();
    }
    delMarker(id) { const m = this.mk.get(id); if (m) { m.el.remove(); this.mk.delete(id); } }
    setRoute(pts) { this.rt = pts && pts.length > 1 ? pts : null; this.draw(); }
    draw() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); }); }
    paint() {
      const s = this.size(), W = s[0], H = s[1], c = this.ctr(), zi = clamp(Math.round(this.z), 0, 18), sc = Math.pow(2, this.z - zi), ts = TS * sc, n = Math.pow(2, zi);
      const x0 = Math.floor((c[0] - W / 2) / ts), x1 = Math.floor((c[0] + W / 2) / ts), y0 = Math.floor((c[1] - H / 2) / ts), y1 = Math.floor((c[1] + H / 2) / ts), need = new Set();
      for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        const key = zi + '/' + tx + '/' + ty; need.add(key);
        let im = this.tiles.get(key);
        if (!im) { im = new Image(); im.className = 'gm-t'; im.alt = ''; im.draggable = false; im.onerror = () => { im.style.visibility = 'hidden'; }; im.src = TILE.replace('{z}', zi).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty); this.tl.appendChild(im); this.tiles.set(key, im); }
        im.style.transform = 'translate(' + (tx * ts - c[0] + W / 2) + 'px,' + (ty * ts - c[1] + H / 2) + 'px)'; im.style.width = im.style.height = (ts + 0.6) + 'px';
      }
      for (const [k, im] of this.tiles) if (!need.has(k)) { im.remove(); this.tiles.delete(k); }
      this.mk.forEach((m) => { const p = this.scr(m.lat, m.lon); m.el.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)'; });
      const d = this.rt ? 'M' + this.rt.map((p) => { const q = this.scr(p[0], p[1]); return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L') : '';
      this.rc.setAttribute('d', d); this.rl.setAttribute('d', d);
    }
    bind() {
      const el = this.el;
      el.addEventListener('pointerdown', (e) => { try { el.setPointerCapture(e.pointerId); } catch (x) {} this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
      el.addEventListener('pointermove', (e) => {
        const p = this.ptrs.get(e.pointerId); if (!p) return;
        if (this.ptrs.size === 1) { this.panBy(e.clientX - p.x, e.clientY - p.y); this.userMoved(); }
        else if (this.ptrs.size === 2) { const o = [...this.ptrs.entries()].find((en) => en[0] !== e.pointerId)[1], a = Math.hypot(p.x - o.x, p.y - o.y), b = Math.hypot(e.clientX - o.x, e.clientY - o.y); if (a > 0 && b > 0) this.zoomBy(Math.log2(b / a)); this.userMoved(); }
        p.x = e.clientX; p.y = e.clientY;
      });
      const up = (e) => { this.ptrs.delete(e.pointerId); };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 0.5 : -0.5); this.userMoved(); }, { passive: false });
      el.addEventListener('dblclick', () => { this.zoomBy(1); this.userMoved(); });
    }
  }

  const UI = { map: null, wrap: null, follow: true, placed: false, fitKey: '', routeKey: '', lastFetch: 0, route: null, pend: new Set(), chip: '' };
  const IC = {
    loc: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/></svg>',
    pw: '<svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M17.7 6.6a8 8 0 1 1-11.4 0"/></svg>',
    coin: '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><ellipse cx="15" cy="19" rx="11" ry="8.5" fill="#34a853"/><circle cx="23.5" cy="16.5" r="1.4" fill="#0f1115"/><path d="M5 14 3 9l5 2z" fill="#34a853"/><rect x="12" y="8.2" width="7" height="2.4" rx="1.2" fill="#0f1115"/><rect x="9" y="25" width="3" height="4" rx="1" fill="#2d8f47"/><rect x="18" y="25" width="3" height="4" rx="1" fill="#2d8f47"/></svg>',
    rest: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#fff" aria-hidden="true"><path d="M7 2v8a2 2 0 0 0 1.5 1.9V22h2V11.9A2 2 0 0 0 12 10V2h-1.5v6H9.7V2H8.3v6H7.5V2zM16.5 2c-1.7 1.3-2.5 3.5-2.5 6 0 1.8.7 3 2 3.4V22h2V2z"/></svg>'
  };
  const mkPick = '<div class="gm-pin pick">' + IC.rest + '</div>', mkDest = '<div class="gm-pin dest"><i></i></div>', mkMe = '<div class="gm-me"><i></i></div>';

  function build() {
    const ref = document.getElementById('riderAvail'); if (!ref || UI.wrap) return;
    const w = document.createElement('div'); w.id = 'riderMap'; w.hidden = true;
    w.innerHTML = '<div class="gm-canvas"></div><div class="gm-ov">' +
      '<div class="gm-pill"><i class="gm-dot" id="gmDotP"></i><span id="gmPillT"></span></div>' +
      '<button type="button" class="gm-loc" id="gmLoc" aria-label="Centrar en mi ubicación">' + IC.loc + '</button>' +
      '<div class="gm-chip" id="gmChip" hidden></div>' +
      '<button type="button" class="gm-pw" id="onlineSw" data-act="online" role="switch" aria-checked="false">' + IC.pw + '<b id="gmPwT"></b></button>' +
      '<div class="gm-stats"><span class="gm-ic">' + IC.coin + '</span><b id="gmHoy"></b></div>' +
      '<a class="gm-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">Mapa de apoyo · © OpenStreetMap</a></div>';
    ref.parentNode.insertBefore(w, ref); UI.wrap = w;
    UI.map = new GMap(w.querySelector('.gm-canvas'));
    UI.map.userMoved = () => { UI.follow = false; };
    w.querySelector('#gmLoc').addEventListener('click', () => {
      UI.follow = true;
      if (S.pos) UI.map.setView(S.pos.lat, S.pos.lon, 16.5); else toast('Todavía no encuentro tu ubicación. Enciende el GPS.');
    });
  }
  function put(el, t) { if (el && el.textContent !== t) el.textContent = t; }
  function sizeIt() {
    const w = UI.wrap, tabs = document.getElementById('tabs'), top = w.getBoundingClientRect().top + window.scrollY, th = tabs && !tabs.hidden ? tabs.offsetHeight : 0;
    const h = Math.max(380, Math.round(window.innerHeight - top - th - 8));
    if (w.style.height !== h + 'px') { w.style.height = h + 'px'; UI.map.draw(); }
  }
  const llTxt = (p) => p[0].toFixed(5) + ',' + p[1].toFixed(5);
  async function fetchRoute(wps, key) {
    UI.lastFetch = Date.now();
    let res = null;
    try {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + wps.map((p) => p[1].toFixed(5) + ',' + p[0].toFixed(5)).join(';') + '?overview=full&geometries=geojson', { signal: ctl.signal }); clearTimeout(tm);
      const j = await r.json(), rt = j && j.routes && j.routes[0];
      if (rt) res = { pts: rt.geometry.coordinates.map((c) => [c[1], c[0]]), m: rt.legs && rt.legs[0] ? rt.legs[0].distance : rt.distance, s: rt.legs && rt.legs[0] ? rt.legs[0].duration : rt.duration };
    } catch (e) {}
    if (!res) res = { pts: wps, m: 0, s: 0, straight: true };
    if (UI.routeKey === key) { UI.route = res; try { render(); } catch (e) {} }
  }
  function ptOf(txt) {
    const c = geoCached(txt);
    if (c === undefined) { const k = nrm(txt); if (k && !UI.pend.has(k)) { UI.pend.add(k); geoPoint(txt).then(() => { UI.pend.delete(k); try { render(); } catch (e) {} }); } return null; }
    return c || null;
  }
  function sync(ctx) {
    const show = view() === 'rider' && S.tab === 'disp';
    build(); if (!UI.wrap) return;
    const was = !UI.wrap.hidden; UI.wrap.hidden = !show; document.body.classList.toggle('map-on', show);
    if (!show) return;
    if (!was) window.scrollTo(0, 0);
    const map = UI.map; sizeIt();
    // estado y textos
    const on = !!S.online, gps = S.posErr ? 'bad' : (S.pos ? 'ok' : 'wait');
    const pill = !on ? ['Desconectado', 'bad'] : S.posErr ? ['Enciende tu GPS', 'bad'] : !S.pos ? ['Buscando GPS…', 'wait'] : ['Estás en línea', 'ok'];
    put(document.getElementById('gmPillT'), pill[0]); const dp = document.getElementById('gmDotP'); if (dp.dataset.s !== pill[1]) { dp.dataset.s = pill[1]; dp.className = 'gm-dot ' + pill[1]; }
    const pw = document.getElementById('onlineSw'); put(document.getElementById('gmPwT'), on ? 'DESCONECTAR' : 'CONECTAR');
    pw.setAttribute('aria-checked', on ? 'true' : 'false'); pw.classList.toggle('on', on);
    const net = (o) => (Number(o.tarifa) || 0) - comC(o) / 100, wk = new Date(); wk.setHours(0, 0, 0, 0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7));
    const hoy = ctx.doneToday.reduce((t, o) => t + net(o), 0), sem = ctx.done.filter((o) => (o.entregadoEn || o.creadoEn || 0) >= wk.getTime()).reduce((t, o) => t + net(o), 0);
    put(document.getElementById('gmHoy'), 'Hoy ' + m2(hoy) + ' · ' + ctx.doneToday.length + (ctx.doneToday.length === 1 ? ' entrega' : ' entregas'));
    // mi posición
    if (on && S.pos) {
      map.setMarker('me', S.pos.lat, S.pos.lon, mkMe, 'me');
      if (!UI.placed) { UI.placed = true; UI.follow = true; map.setView(S.pos.lat, S.pos.lon, 16.5); }
      else if (UI.follow) map.setView(S.pos.lat, S.pos.lon);
    } else { map.delMarker('me'); if (!UI.placed && !S.pos) map.setView(TEPIC[0], TEPIC[1], 13); }
    // pedido activo: ruta
    const offer = ctx.offer && ctx.offer.estado === 'abierto' ? ctx.offer : null, o = offer || ctx.act0, chip = document.getElementById('gmChip');
    if (!o) { map.setRoute(null); map.delMarker('pick'); map.delMarker('dest'); UI.route = null; UI.routeKey = ''; UI.fitKey = ''; if (UI.chip) { UI.chip = ''; chip.hidden = true; chip.innerHTML = ''; } return; }
    const pk = (offer || o.estado === 'asignado') ? ptOf(o.pickup) : null, ds = ptOf(o.dest), me = on && S.pos ? [S.pos.lat, S.pos.lon] : null;
    if (pk) map.setMarker('pick', pk[0], pk[1], mkPick, 'pick'); else map.delMarker('pick');
    if (ds) map.setMarker('dest', ds[0], ds[1], mkDest, 'dest'); else map.delMarker('dest');
    const wps = [me, pk, ds].filter(Boolean), target = pk || ds;
    if (wps.length >= 2) {
      const key = o.id + o.estado + '|' + wps.map((p) => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join('|');
      if (key !== UI.routeKey && (!UI.route || Date.now() - UI.lastFetch > 15000 || UI.fitKey !== o.id + o.estado)) { UI.routeKey = key; if (UI.fitKey !== o.id + o.estado) UI.route = null; fetchRoute(wps, key); }
      if (UI.route) { map.setRoute(UI.route.pts); UI.route.oid = o.id; }
      const fk = o.id + o.estado; if (UI.fitKey !== fk) { UI.fitKey = fk; UI.follow = false; let bb = 210; if (offer) { const sh = document.getElementById('sheet'), mr = UI.wrap.getBoundingClientRect(); bb = Math.max(60, mr.bottom - (window.innerHeight - (sh ? sh.offsetHeight : 0)) + 36); } map.fit(wps, { t: offer ? 90 : 160, b: bb }); }
    } else {
      // no se pudo ubicar el destino: no dejar la ruta vieja (la del restaurante) como si fuera la actual
      if (UI.route || UI.routeKey) { map.setRoute(null); UI.route = null; UI.routeKey = ''; }
      const fk2 = o.id + o.estado; if (UI.fitKey !== fk2) { UI.fitKey = fk2; UI.follow = true; if (me) map.setView(me[0], me[1], 16); }
    }
    const km = document.getElementById('shKm'); if (km) put(km, offer && UI.route && UI.route.m ? offerKm(UI.route) : (km.textContent || ''));
    if (offer) { if (UI.chip) { UI.chip = ''; chip.hidden = true; chip.innerHTML = ''; } return; }
    const r = UI.route, lbl = o.estado === 'asignado' ? 'Recoger: ' + (o.shop || 'restaurante') : 'Entregar: ' + (destParts(o.dest).dir || '').slice(0, 40);
    const pend = o.estado !== 'asignado' && !ds && geoCached(o.dest) === undefined, miss = o.estado !== 'asignado' && !ds && !pend, apx = !miss && ds && geoApprox(o.estado === 'asignado' ? o.pickup : o.dest);
    const dtxt = r && r.m ? ' · ' + (r.m < 1000 ? Math.round(r.m / 10) * 10 + ' m' : (r.m / 1000).toFixed(1) + ' km') + ' · ' + Math.max(1, Math.round(r.s / 60)) + ' min' : '';
    const extra = pend ? ' · ubicando…' : miss ? ' · no la ubico en el mapa, usa Google Maps' : dtxt + (apx ? ' · aprox.' : '');
    const nav = mapsUrl(o.estado === 'asignado' ? o.pickup : o.dest); // Google encuentra la dirección escrita mejor que el mapa de apoyo
    const html = '<span>' + esc(lbl + extra) + '</span><a href="' + esc(nav) + '" target="_blank" rel="noopener">Navegar</a>';
    if (UI.chip !== html) { UI.chip = html; chip.innerHTML = html; chip.hidden = false; }
  }
  window.__mapSync = sync; window.__gmap = UI;
  window.addEventListener('resize', () => { try { if (UI.wrap && !UI.wrap.hidden) sizeIt(); } catch (e) {} });
  const st = document.createElement('style');
  st.textContent = '#riderMap{position:relative;margin:4px -13px 8px;border-radius:16px;overflow:hidden;background:#0a3047;box-shadow:0 2px 10px rgba(0,0,0,.25);isolation:isolate}#riderMap[hidden]{display:none}' +
    '.gm-canvas{position:absolute;inset:0;touch-action:none;overflow:hidden;cursor:grab;background:#0a3047}.gm-tiles,.gm-mk{position:absolute;inset:0}.gm-t{position:absolute;left:0;top:0;max-width:none;user-select:none;-webkit-user-drag:none;filter:invert(1) hue-rotate(188deg) brightness(.85) contrast(.95) saturate(.5);will-change:transform}' +
    '.gm-tint{position:absolute;inset:0;background:#0d5a80;mix-blend-mode:screen;opacity:.5;pointer-events:none}.gm-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}.gm-rc{fill:none;stroke:#0b1620;stroke-width:11;stroke-linecap:round;stroke-linejoin:round;opacity:.75}.gm-rl{fill:none;stroke:#f6a000;stroke-width:6;stroke-linecap:round;stroke-linejoin:round}' +
    '.gm-m{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}.gm-me i{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;background:#2f7df6;border:3.5px solid #fff;box-shadow:0 0 0 8px rgba(47,125,246,.28),0 2px 6px rgba(0,0,0,.5)}' +
    '.gm-pin{position:absolute;left:-19px;top:-46px;width:38px;height:38px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:grid;place-items:center;border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.5)}.gm-pin.pick{background:#f08c00}.gm-pin.pick svg{transform:rotate(45deg)}.gm-pin.dest{background:#e53935}.gm-pin.dest i{width:12px;height:12px;border-radius:50%;background:#fff;display:block}' +
    '.gm-ov{position:absolute;inset:0;pointer-events:none}.gm-ov>*{pointer-events:auto}' +
    '.gm-pill{position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:10px;background:rgba(10,12,16,.92);color:#fff;border-radius:99px;padding:11px 18px;font-weight:800;font-size:17px;box-shadow:0 2px 8px rgba(0,0,0,.4)}.gm-dot{width:13px;height:13px;border-radius:50%;background:#1fa855}.gm-dot.bad{background:#e53935}.gm-dot.wait{background:#f6b400}' +
    '.gm-loc{position:absolute;right:12px;top:12px;width:62px;height:62px;border-radius:50%;border:0;background:rgba(10,12,16,.92);color:#fff;display:grid;place-items:center;box-shadow:0 2px 8px rgba(0,0,0,.4)}' +
    '.gm-chip{position:absolute;left:12px;right:12px;top:72px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(255,255,255,.96);color:#16202a;border-radius:14px;padding:10px 14px;font-weight:700;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.35)}.gm-chip[hidden]{display:none}.gm-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gm-chip a{flex:none;background:#16202a;color:#fff;border-radius:99px;padding:8px 16px;text-decoration:none;font-weight:800}' +
    '.gm-pw{position:absolute;left:12px;bottom:80px;width:86px;height:86px;border-radius:50%;border:4px solid #fff;background:#1fa855;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;box-shadow:0 4px 14px rgba(0,0,0,.5)}.gm-pw.on{background:#e53935}.gm-pw b{font-size:9.5px;letter-spacing:0;font-weight:800;white-space:nowrap}.gm-pw svg{width:30px;height:30px}' +
    '.gm-stats{position:absolute;left:12px;right:12px;bottom:12px;display:flex;align-items:center;gap:12px;background:rgba(10,12,16,.94);color:#fff;border-radius:18px;padding:12px 14px;font-size:15.5px;white-space:nowrap}.gm-stats b{flex:1;font-weight:800;min-width:0}.gm-stats em{font-style:normal;opacity:.75;font-size:14.5px}.gm-ic{display:grid;place-items:center}' +
    '.gm-attr{position:absolute;right:8px;bottom:82px;font-size:10px;color:rgba(255,255,255,.7);text-decoration:none;background:rgba(0,0,0,.35);padding:1px 5px;border-radius:5px}' +
    '.map-on #modeBar{display:none!important}' +
    '.sheet{bottom:0!important;padding-inline:0!important;z-index:25!important}.sheet-in.of{max-width:520px;border:0;border-radius:24px 24px 0 0;padding:16px 16px calc(14px + env(safe-area-inset-bottom,0px));gap:0;box-shadow:0 -6px 24px rgba(0,0,0,.3)}' +
    '.of-shop{font-weight:800;font-size:17px;margin-bottom:8px}.of-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.of-top small{color:var(--muted);font-size:14px}.of-gan{display:block;font-size:44px;line-height:1.05;color:var(--green)}.of-d{text-align:right;padding-top:4px}.of-d b{display:block;font-size:19px}.of-d small{display:block;margin-top:2px}' +
    '.of-box{margin-top:12px;background:#fff4d6;border:1.5px solid #f0b429;border-radius:14px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;color:#16202a}.of-r{display:flex;gap:10px;font-size:16px;line-height:1.3;font-weight:600}.of-r.pay{color:#c2620a;font-weight:800}.of-r.get{color:#2e7d32;font-weight:800}.of-r>span:first-child{flex:none;width:24px;text-align:center}' +
    '.of-com{text-align:center;color:var(--muted);font-size:14px;margin-top:10px}.of-act{display:flex;gap:10px;margin-top:10px}.of-no{flex:0 0 34%;min-height:58px;border-radius:16px;border:1.5px solid var(--line);background:var(--surface);color:var(--amber-fg);font-weight:800;font-size:17px}' +
    '.of-ok{position:relative;overflow:hidden;flex:1;min-height:58px;border-radius:16px;border:0;background:#2e8b3d;color:#fff;font-weight:800;font-size:21px}.of-ok.late{background:#d63030}.of-ok:disabled{opacity:.75}.of-bar{position:absolute;right:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.55)}.of-t{position:relative}';
  document.head.appendChild(st);
})();

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
    e.preventDefault(); ev = e; window.__instEv = e;
    hint.innerHTML = '<b>Instala Gasca en tu celular</b><button class="btn primary block" type="button" id="installBtn">Instalar Gasca</button>';
    const b = document.getElementById('installBtn');
    if (b) b.addEventListener('click', async () => { try { ev.prompt(); await ev.userChoice; } catch (_) {} ev = null; window.__instEv = null; hint.hidden = true; });
  });
  window.addEventListener('appinstalled', () => { hint.hidden = true; });
})();

/* QR de instalación: ?instalar=1 muestra "¿Quieres descargar la aplicación?" con Sí / Ahora no. */
(function () {
  let q = ''; try { q = new URLSearchParams(location.search).get('instalar') || ''; } catch (e) {}
  if (!q) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  const st = document.createElement('style');
  st.textContent = '#instOv{position:fixed;inset:0;z-index:99999;background:linear-gradient(160deg,#f6b400,#ffd24d);display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit}#instOv .ic{background:#fff;border-radius:28px;padding:26px 22px;max-width:380px;width:100%;text-align:center;color:#16202a;box-shadow:0 12px 34px rgba(0,0,0,.25)}#instOv .lg{font-size:54px;line-height:1}#instOv h2{margin:10px 0 6px;font-size:26px}#instOv p{margin:6px 0 16px;font-size:17px;line-height:1.35}#instOv button{display:block;width:100%;min-height:56px;border-radius:16px;font:inherit;font-size:19px;font-weight:800;border:0;margin-top:10px}#instOv .yes{background:#16202a;color:#ffc61a}#instOv .no{background:#fff;color:#16202a;border:2px solid #cfd6de}#instOv .st{background:#f3f5f8;border-radius:14px;padding:12px;text-align:left;font-size:16px;line-height:1.4;margin-top:12px}';
  document.head.appendChild(st);
  const ov = document.createElement('div'); ov.id = 'instOv';
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  ov.innerHTML = '<div class="ic"><div class="lg">🛵</div><h2>Gasca</h2><div id="instBody"></div></div>';
  document.body.appendChild(ov);
  const body = ov.querySelector('#instBody'), close = () => ov.remove();
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const steps = () => ios
    ? '<div class="st"><b>En iPhone:</b><br>1. Toca el botón <b>Compartir</b> (el cuadro con la flecha ↑) de Safari.<br>2. Elige <b>Agregar a pantalla de inicio</b>.<br>3. Toca <b>Agregar</b>.</div>'
    : '<div class="st"><b>En Android:</b><br>1. Toca los <b>tres puntos ⋮</b> de arriba a la derecha.<br>2. Elige <b>Instalar app</b> o <b>Agregar a pantalla de inicio</b>.<br>3. Toca <b>Instalar</b>.</div>';
  if (standalone) { body.innerHTML = '<p>Ya tienes Gasca instalada en este celular. 🎉</p><button class="yes" type="button" id="instNo">Continuar</button>'; body.querySelector('#instNo').onclick = close; return; }
  body.innerHTML = '<p><b>¿Quieres descargar la aplicación Gasca?</b><br>Queda en tu pantalla de inicio, como cualquier app.</p><button class="yes" type="button" id="instYes">Sí, descargar</button><button class="no" type="button" id="instNo">Ahora no</button>';
  body.querySelector('#instNo').onclick = close;
  body.querySelector('#instYes').onclick = async () => {
    const e = window.__instEv;
    if (e) {
      try { e.prompt(); const r = await e.userChoice; window.__instEv = null; if (r && r.outcome === 'accepted') { body.innerHTML = '<p>¡Listo! Gasca se está instalando. Búscala en tu pantalla de inicio. 🎉</p><button class="yes" type="button" id="instOk">Continuar</button>'; body.querySelector('#instOk').onclick = close; return; } } catch (_) {}
    }
    body.innerHTML = '<p>Sigue estos pasos para instalarla:</p>' + steps() + '<button class="yes" type="button" id="instOk">Entendido</button>';
    body.querySelector('#instOk').onclick = close;
  };
  window.addEventListener('appinstalled', close);
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
const REG_TEXT = "GASCA\n\nREGLAMENTO OPERATIVO PARA REPARTIDORES\n\nVersión: 1.1\nLugar de aplicación: Tepic, Nayarit, México\nFecha de entrada en vigor: 19 de octubre de 2026\n\nCAPÍTULO I. DISPOSICIONES GENERALES\n\nArtículo 1. Objeto\n\nEl presente reglamento establece las condiciones de operación, obligaciones, responsabilidades y medidas de seguridad aplicables a los repartidores que prestan servicios mediante la plataforma GASCA.\n\nSu finalidad es garantizar una operación organizada, segura y transparente, así como proteger los intereses de los clientes, repartidores y demás participantes.\n\nLas disposiciones deberán interpretarse y aplicarse conforme a la legislación vigente y a la naturaleza jurídica de la relación correspondiente.\n\nArtículo 2. Requisitos de registro\n\nPara registrarse y operar en GASCA, el repartidor deberá:\n\n1. Ser mayor de edad.\n2. Proporcionar información personal verdadera y actualizada.\n3. Presentar identificación oficial vigente.\n4. Contar con un número telefónico activo.\n5. Presentar licencia de conducir y documentación vehicular cuando corresponda.\n6. Cumplir los requisitos de seguridad aplicables.\n7. Conocer y aceptar las condiciones operativas.\n8. Tener una cuenta individual autorizada.\n\nCAPÍTULO II. MONEDERO DIGITAL Y COMISIONES\n\nArtículo 3. Monedero GASCA\n\nCada repartidor contará con un monedero digital dentro de la aplicación GASCA, mediante el cual se administrará su saldo operativo.\n\nEste saldo se utilizará para cubrir las comisiones que correspondan a los servicios de envío realizados.\n\nEl monedero permitirá consultar recargas, comisiones, reservas, devoluciones y ajustes.\n\nArtículo 4. Comisión por servicio\n\nGASCA cobrará una comisión equivalente al 13% del costo de cada envío completado.\n\nLa comisión se calculará exclusivamente sobre el costo del servicio de envío y no sobre el valor de mercancías o productos transportados.\n\nEl porcentaje aplicable deberá informarse antes de aceptar el servicio.\n\nArtículo 5. Saldo suficiente\n\nPara aceptar un pedido, el repartidor deberá contar con saldo disponible suficiente para cubrir la comisión correspondiente.\n\nSi el saldo resulta insuficiente, la aplicación impedirá aceptar nuevos pedidos hasta que se realice una recarga.\n\nLa falta de saldo no cancelará automáticamente los pedidos previamente aceptados.\n\nArtículo 6. Descuento de comisiones\n\nAl aceptar un pedido, GASCA podrá reservar temporalmente la comisión estimada.\n\nUna vez confirmada la entrega, la comisión se descontará definitivamente del saldo del repartidor.\n\nSi el pedido se cancela sin que corresponda un cargo previamente informado y legalmente procedente, la reserva será liberada.\n\nNo podrá realizarse un doble cobro por el mismo servicio.\n\nArtículo 7. Recargas y aclaraciones\n\nLas recargas deberán realizarse mediante los métodos autorizados por GASCA.\n\nCada operación deberá contar con un registro que permita identificar su fecha, importe y referencia.\n\nEl repartidor podrá solicitar la revisión de movimientos incorrectos y conocer las condiciones aplicables a la devolución de saldos.\n\nCAPÍTULO III. COBROS EN EFECTIVO\n\nArtículo 8. Forma de pago\n\nTodos los pagos de los servicios de envío se realizarán en efectivo directamente al repartidor.\n\nEl repartidor recibirá el importe completo autorizado por el servicio, mientras que la comisión correspondiente a GASCA será descontada del saldo de su monedero digital.\n\nArtículo 9. Manejo del efectivo\n\nEl repartidor deberá:\n\n1. Cobrar únicamente los importes autorizados.\n2. Registrar correctamente la recepción del pago.\n3. No modificar unilateralmente el costo del envío.\n4. Entregar al destinatario los productos conforme a las instrucciones del servicio.\n5. Reportar cualquier diferencia o incidencia en los cobros.\n\nCuando un pedido incluya dinero correspondiente al valor de mercancías o pagos por cuenta de terceros, dichos importes deberán identificarse por separado y entregarse a quien corresponda.\n\nArtículo 10. Prohibición de cobros adicionales\n\nQueda prohibido exigir propinas obligatorias, cargos no autorizados o cantidades adicionales a las informadas al cliente.\n\nLas propinas voluntarias no formarán parte de la base de cálculo de la comisión de GASCA, salvo acuerdo válido y expresamente informado.\n\nCAPÍTULO IV. OPERACIÓN DE LOS SERVICIOS\n\nArtículo 11. Disponibilidad\n\nPara recibir pedidos, el repartidor deberá:\n\n1. Mantener su cuenta autorizada.\n2. Contar con saldo suficiente.\n3. Estar disponible para trabajar.\n4. Cumplir los requisitos de documentación y seguridad.\n5. No tener una restricción operativa vigente.\n\nArtículo 12. Zonas de servicio\n\nLos repartidores podrán recibir servicios dentro de las zonas autorizadas por GASCA.\n\nLa asignación dependerá de la cobertura, disponibilidad y condiciones del pedido.\n\nArtículo 13. Aceptación de pedidos\n\nAl aceptar un servicio, el repartidor deberá cumplir las condiciones informadas, salvo que exista una causa justificada para cancelarlo o suspenderlo.\n\nNo podrá transferir un pedido a otra persona sin autorización.\n\nArtículo 14. Pedidos simultáneos\n\nEl repartidor no podrá exceder el límite de pedidos activos establecido por GASCA.\n\nEste límite deberá comunicarse antes de su aplicación.\n\nArtículo 15. Recolección y entrega\n\nEl repartidor deberá:\n\n1. Acudir al punto de recolección.\n2. Verificar los datos del servicio.\n3. Transportar el paquete de forma segura.\n4. Mantener actualizado el estado del pedido.\n5. Entregarlo a la persona autorizada.\n6. Registrar la evidencia correspondiente.\n\nArtículo 16. Comprobante de entrega\n\nGASCA podrá requerir un código de confirmación, comprobante electrónico, fotografía permitida u otro mecanismo de validación.\n\nNo podrá registrarse una entrega como completada sin la confirmación correspondiente.\n\nArtículo 17. Cancelaciones\n\nLas cancelaciones deberán registrarse mediante los canales oficiales.\n\nSe considerarán circunstancias justificadas los riesgos de seguridad, emergencias, fallas mecánicas, direcciones incorrectas y otras causas razonables.\n\nLas cancelaciones injustificadas reiteradas podrán revisarse administrativamente, sin imponer sanciones por el ejercicio legítimo de derechos.\n\nCAPÍTULO V. SEGURIDAD Y CONDUCTA\n\nArtículo 18. Seguridad vial\n\nEl repartidor deberá respetar las normas de tránsito, utilizar el equipo de protección correspondiente y mantener su vehículo en condiciones seguras.\n\nQueda prohibido conducir bajo los efectos del alcohol o sustancias que afecten la capacidad de conducción.\n\nArtículo 19. Protección de mercancías\n\nQueda prohibido abrir, sustraer, utilizar, alterar o retener injustificadamente los paquetes transportados.\n\nCualquier daño, pérdida o incidencia deberá reportarse oportunamente.\n\nArtículo 20. Conducta profesional\n\nEl repartidor deberá mantener un trato respetuoso hacia clientes, comercios y personal de GASCA.\n\nNo se permitirán amenazas, agresiones, acoso, discriminación ni actos fraudulentos.\n\nArtículo 21. Confidencialidad\n\nLos datos de clientes, direcciones, teléfonos y detalles de los pedidos únicamente podrán utilizarse para realizar los servicios autorizados.\n\nQueda prohibida su divulgación o utilización para fines personales.\n\nArtículo 22. Uso de la cuenta\n\nLa cuenta de repartidor será personal.\n\nQueda prohibido compartir contraseñas, prestar la cuenta o suplantar la identidad de otra persona.\n\nCAPÍTULO VI. RESTRICCIONES Y MEDIDAS ADMINISTRATIVAS\n\nArtículo 23. Restricciones operativas\n\nGASCA podrá impedir nuevas asignaciones cuando:\n\n1. El saldo sea insuficiente para cubrir la comisión del pedido.\n2. La documentación obligatoria esté vencida.\n3. La cuenta se encuentre suspendida.\n4. El repartidor no esté disponible.\n5. Se haya alcanzado el máximo de pedidos simultáneos.\n6. Exista una situación de seguridad que justifique una restricción preventiva.\n\nLas restricciones deberán ser proporcionales y estar sujetas a los mecanismos de revisión correspondientes.\n\nArtículo 24. Medidas disciplinarias\n\nAnte incumplimientos acreditados podrán aplicarse, según su gravedad:\n\n1. Advertencia documentada.\n2. Restricción temporal de nuevas asignaciones.\n3. Suspensión preventiva durante una investigación.\n4. Terminación del acceso a la plataforma, cuando exista causa justificada.\n\nSe deberá permitir al repartidor presentar aclaraciones y pruebas.\n\nArtículo 25. Aclaraciones\n\nLos repartidores podrán solicitar revisión de cobros, comisiones, bloqueos, cancelaciones y reportes.\n\nGASCA establecerá un canal oficial para recibir y resolver dichas solicitudes.\n\nArtículo 26. Modificaciones\n\nGASCA podrá actualizar el reglamento, comunicando oportunamente las modificaciones.\n\nNinguna disposición podrá utilizarse para limitar derechos reconocidos por la legislación aplicable.\n\n---\n\nGASCA\n\nAVISO DE PRIVACIDAD INTEGRAL PARA REPARTIDORES\n\nÚltima actualización: 19 de octubre de 2026\n\n1. Identidad y domicilio del responsable\n\nCruz Aguirre Martínez, que opera comercialmente bajo la denominación GASCA, con domicilio en calle Nudo 722, fraccionamiento Altavela, C.P. 63735, San Clemente de Lima, Nayarit, México, es responsable del tratamiento y protección de los datos personales de los repartidores.\n\nCorreo electrónico de privacidad: aguirremartinezcruzz@gmail.com\n\n2. Datos personales que se recaban\n\nGASCA podrá recopilar, según las funciones efectivamente utilizadas:\n\n- Nombre completo.\n- Número telefónico y correo electrónico.\n- Domicilio.\n- Fotografía de perfil.\n- Identificación oficial.\n- Licencia de conducir.\n- Documentación del vehículo.\n- Datos necesarios para recargas, pagos y conciliaciones.\n- Saldo operativo e historial de movimientos.\n- Historial de pedidos y entregas.\n- Ubicación geográfica durante servicios autorizados.\n- Reportes e incidencias operativas.\n\nGASCA no solicitará datos personales sensibles salvo que exista una finalidad legítima y se cumplan los requisitos legales correspondientes.\n\n3. Finalidades del tratamiento\n\nLos datos personales serán utilizados para:\n\n1. Registrar e identificar repartidores.\n2. Verificar requisitos de incorporación.\n3. Administrar cuentas y accesos.\n4. Gestionar el monedero digital.\n5. Registrar recargas y comisiones.\n6. Verificar saldos disponibles.\n7. Asignar y supervisar servicios de entrega.\n8. Facilitar la comunicación operativa.\n9. Confirmar entregas.\n10. Atender incidencias y reclamaciones.\n11. Prevenir fraudes y accesos no autorizados.\n12. Cumplir obligaciones legales.\n\nCualquier finalidad secundaria, como el envío de publicidad no necesaria para la operación, será informada por separado y contará con los mecanismos de oposición correspondientes.\n\n4. Tratamiento de la ubicación geográfica\n\nPara recibir pedidos, el repartidor debe mantener el GPS de su celular encendido y la aplicación abierta mientras esté En línea. GASCA utilizará la ubicación en tiempo real únicamente para mostrarle los pedidos cercanos, facilitar rutas, verificar entregas y atender incidentes.\n\nLa ubicación se procesa en el dispositivo para filtrar los pedidos; GASCA no guarda un historial de recorridos. Al ponerse Fuera de línea o cerrar la aplicación, la ubicación deja de utilizarse.\n\nEl repartidor puede apagar el GPS en cualquier momento, con lo cual dejará de recibir pedidos.\n\n5. Uso y comunicación de datos\n\nGASCA podrá comunicar a clientes y comercios la información estrictamente necesaria para coordinar entregas.\n\nAsimismo, podrá utilizar proveedores tecnológicos para administrar la plataforma, procesar comunicaciones y almacenar información, bajo las obligaciones de confidencialidad y seguridad correspondientes.\n\nCuando una transferencia de datos requiera consentimiento conforme a la legislación aplicable, este será solicitado previamente.\n\nGASCA no venderá los datos personales de los repartidores.\n\n6. Seguridad de la información\n\nGASCA implementará medidas administrativas, técnicas y físicas razonables para proteger los datos contra pérdida, alteración, acceso no autorizado y divulgación indebida.\n\nEl acceso estará limitado a personas y sistemas autorizados.\n\n7. Conservación de datos\n\nLos datos personales se conservarán durante el tiempo necesario para cumplir las finalidades informadas y las obligaciones legales aplicables.\n\nUna vez concluido dicho periodo, serán eliminados, bloqueados o anonimizados según corresponda.\n\n8. Derechos ARCO\n\nEl titular podrá ejercer sus derechos de acceso, rectificación, cancelación y oposición.\n\nPara ello deberá presentar una solicitud a:\n\naguirremartinezcruzz@gmail.com\n\nLa solicitud deberá contener su nombre, medio para recibir respuesta, descripción del derecho que desea ejercer y elementos necesarios para acreditar su identidad.\n\nGASCA responderá dentro de los plazos legales aplicables.\n\n9. Revocación del consentimiento\n\nCuando legalmente proceda, el repartidor podrá solicitar la revocación del consentimiento otorgado para el tratamiento de sus datos personales.\n\nLa revocación no tendrá efectos retroactivos y estará sujeta a las obligaciones legales correspondientes.\n\n10. Limitación del uso o divulgación\n\nEl titular podrá solicitar la limitación del uso o divulgación de sus datos mediante el correo de privacidad indicado.\n\n11. Modificaciones al aviso\n\nCualquier modificación al presente aviso será comunicada a través de la aplicación GASCA.\n\nLa versión vigente estará disponible para consulta.";
const REG_CONST = "Declaro que he recibido o tenido acceso al Reglamento Operativo para Repartidores GASCA y al Aviso de Privacidad Integral.\n\nReconozco que he tenido oportunidad de leer ambos documentos y solicitar aclaraciones.";
const PRIV_V = 'P1.0';
const PRIV_TEXT = "GASCA\n\nAVISO DE PRIVACIDAD INTEGRAL PARA NEGOCIOS Y USUARIOS DE ENVÍOS\n\nVersión: P1.0\nÚltima actualización: 20 de octubre de 2026\n\n1. Identidad y domicilio del responsable\n\nCruz Aguirre Martínez, que opera comercialmente bajo la denominación GASCA, con domicilio en calle Nudo 722, fraccionamiento Altavela, C.P. 63735, San Clemente de Lima, Nayarit, México, es responsable del tratamiento y protección de los datos personales de las tiendas, restaurantes, negocios y personas que solicitan servicios de envío mediante la plataforma GASCA (en adelante, los \"usuarios\").\n\nCorreo electrónico de privacidad: aguirremartinezcruzz@gmail.com\n\n2. Datos personales que se recaban\n\nGASCA podrá recopilar, según las funciones efectivamente utilizadas:\n\n- Nombre completo o, en su caso, nombre del negocio y de su encargado.\n- Número telefónico y, en su caso, correo electrónico.\n- Domicilio del negocio y direcciones de recolección y entrega.\n- Identificación oficial (INE), por el frente y por el reverso, según el tipo de cuenta.\n- Fotografía del rostro (selfie) para confirmar la identidad, cuando se solicite.\n- Comprobante de domicilio y fotografía del local, en el caso de negocios.\n- Datos de los pedidos: descripción de lo que se envía, valor de los productos, montos a cobrar y condiciones de pago.\n- Nombre, teléfono y dirección de las personas destinatarias de los envíos.\n- Historial de pedidos, ofertas y entregas.\n- Reportes e incidencias operativas.\n\nLa identificación oficial y la fotografía del rostro se revisan de forma manual por el responsable. GASCA no realiza reconocimiento facial automatizado.\n\nGASCA no solicitará datos personales sensibles salvo que exista una finalidad legítima y se cumplan los requisitos legales correspondientes.\n\nDatos de terceros: cuando el usuario capture datos de otras personas, como el nombre, teléfono y dirección del destinatario, declara que cuenta con la autorización o el derecho para proporcionarlos y que los utilizará únicamente para realizar el envío.\n\n3. Finalidades del tratamiento\n\nLos datos personales serán utilizados para:\n\n1. Registrar e identificar a los usuarios.\n2. Verificar su identidad y los requisitos para usar la plataforma.\n3. Administrar cuentas y accesos.\n4. Recibir, publicar y dar seguimiento a los pedidos.\n5. Mostrar a los repartidores la información necesaria para recoger y entregar.\n6. Gestionar ofertas, contraofertas y montos de los servicios.\n7. Generar y verificar el código de entrega.\n8. Facilitar la comunicación operativa.\n9. Atender incidencias, aclaraciones y reclamaciones.\n10. Prevenir fraudes, suplantación de identidad y accesos no autorizados.\n11. Cumplir obligaciones legales.\n\nCualquier finalidad secundaria, como el envío de publicidad no necesaria para la operación, será informada por separado y contará con los mecanismos de oposición correspondientes.\n\n4. Ubicación geográfica\n\nA la fecha, GASCA no recaba la ubicación geográfica en tiempo real del dispositivo de los usuarios. Las direcciones se capturan manualmente.\n\nSi en el futuro se habilitara esta función, se informará previamente y se solicitará el consentimiento correspondiente.\n\n5. Uso y comunicación de datos\n\nGASCA comunicará al repartidor que tome un pedido únicamente la información necesaria para realizar el servicio: nombre del usuario o negocio, dirección de recolección, nombre, teléfono y dirección del destinatario, descripción del envío y montos a pagar o cobrar. El repartidor deberá utilizarla solo para ese fin.\n\nAsimismo, GASCA podrá utilizar proveedores tecnológicos para administrar la plataforma, procesar comunicaciones y almacenar información, bajo las obligaciones de confidencialidad y seguridad correspondientes. Estos servicios pueden operar con servidores ubicados fuera de México.\n\nCuando una transferencia de datos requiera consentimiento conforme a la legislación aplicable, este será solicitado previamente.\n\nGASCA no venderá los datos personales de los usuarios.\n\n6. Seguridad de la información\n\nGASCA implementará medidas administrativas, técnicas y físicas razonables para proteger los datos contra pérdida, alteración, acceso no autorizado y divulgación indebida.\n\nEl acceso estará limitado a personas y sistemas autorizados.\n\n7. Conservación de datos\n\nLos datos personales se conservarán durante el tiempo necesario para cumplir las finalidades informadas y las obligaciones legales aplicables.\n\nUna vez concluido dicho periodo, serán eliminados, bloqueados o anonimizados según corresponda.\n\n8. Derechos ARCO\n\nEl titular podrá ejercer sus derechos de acceso, rectificación, cancelación y oposición.\n\nPara ello deberá presentar una solicitud a:\n\naguirremartinezcruzz@gmail.com\n\nLa solicitud deberá contener su nombre, medio para recibir respuesta, descripción del derecho que desea ejercer y elementos necesarios para acreditar su identidad.\n\nGASCA responderá dentro de los plazos legales aplicables.\n\n9. Revocación del consentimiento\n\nCuando legalmente proceda, el usuario podrá solicitar la revocación del consentimiento otorgado para el tratamiento de sus datos personales.\n\nLa revocación no tendrá efectos retroactivos y estará sujeta a las obligaciones legales correspondientes.\n\n10. Limitación del uso o divulgación\n\nEl titular podrá solicitar la limitación del uso o divulgación de sus datos mediante el correo de privacidad indicado.\n\n11. Modificaciones al aviso\n\nCualquier modificación al presente aviso será comunicada a través de la aplicación GASCA.\n\nLa versión vigente estará disponible para consulta.\n\n---\n\nCONSTANCIA DE LECTURA Y ACEPTACIÓN\n\nDeclaro que he leído el Aviso de Privacidad Integral de GASCA.";
const PRIV_CONST = 'Declaro que he leído el Aviso de Privacidad Integral de GASCA y que entiendo cómo se usarán mis datos personales.\n\nSi capturo datos de otras personas (por ejemplo, de quien recibe un envío), cuento con su autorización para hacerlo.';
const needV = () => (S.role === 'rider' ? REG_V : PRIV_V);
function regDone() { return !!(S.regOk || (S.profile && S.profile.reglamentoV === needV())); }
function regHtml(txt) {
  return (txt || (S.role === 'rider' ? REG_TEXT : PRIV_TEXT)).split('\n').map((l) => {
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
    const keepPh = m.querySelector('#issuePhone') ? m.querySelector('#issuePhone').value : '';
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
      '<textarea id="issueNote" maxlength="270" placeholder="Cuéntanos qué pasó (opcional)">' + esc(keep) + '</textarea>' +
      '<label for="issuePhone" style="font-weight:700;font-size:14px">Tu WhatsApp para que soporte te contacte</label><input id="issuePhone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="10 dígitos" value="' + esc(keepPh || lsGet('gasca_myphone') || '') + '" style="width:100%;box-sizing:border-box;min-height:48px;margin:6px 0;padding:10px;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font-size:17px">' +
      '<div class="err inc-note" id="issueErr"></div>' +
      '<button class="btn primary" type="button" id="issueSend"' + (tipo ? '' : ' disabled') + '>Avisar a soporte</button>' +
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(supportUrl('Hola, soy ' + (S.name || 'repartidor') + ' de Gasca. Necesito ayuda con el pedido ' + folio(id) + '.')) + '">Hablar con soporte por WhatsApp</a>' +
      '<button class="btn ghost" type="button" id="issueClose">Cancelar</button></div>';
    m.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => { tipo = b.getAttribute('data-k'); draw(); }));
    document.getElementById('issueClose').addEventListener('click', closeIssue);
    document.getElementById('issueSend').addEventListener('click', async () => {
      const btn = document.getElementById('issueSend'); btn.disabled = true;
      const ph = document.getElementById('issuePhone').value.replace(/\D/g, '').slice(-10);
      if (ph.length !== 10) { const er = document.getElementById('issueErr'); if (er) er.textContent = 'Escribe tu WhatsApp de 10 dígitos para que soporte te llame.'; btn.disabled = false; return; }
      lsSet('gasca_myphone', ph);
      const nota = (document.getElementById('issueNote').value.trim().slice(0, 270) + ' · Tel ' + ph).trim().slice(0, 300), iid = newId();
      try {
        await setDoc(doc(db, 'incidencias', iid), { id: iid, orderId: id, driverId: S.uid, driverName: S.name || 'Repartidor', shop: o.shop || '', folio: folio(id), tipo, nota, estado: 'abierta', creadoEn: Date.now() });
        lsSet('gasca_naSent_' + id, '1'); render();
        draw({ nota });
      } catch (e) { const er = document.getElementById('issueErr'); if (er) er.textContent = 'No se pudo enviar. Escríbenos por WhatsApp.'; btn.disabled = false; }
    });
  };
  draw();
}
const NOANS_RE = /^NO CONTESTAN/;
function noansMap(n) { const m = /GPS (-?\d+\.\d+),(-?\d+\.\d+)/.exec(n || ''); return m ? ' · <a href="https://www.google.com/maps?q=' + m[1] + ',' + m[2] + '" target="_blank" rel="noopener">Ver dónde estaba</a>' : ''; }
const noansMs = () => Number(lsGet('gasca_noans_ms')) || 8 * 60 * 1000;
function askNoAns(id) {
  const o = byId(id);
  if (!canAct() || !o || o.driverId !== S.uid || o.estado !== 'recogido' || document.getElementById('issueModal')) return;
  const key = 'gasca_na_' + id, wait = noansMs();
  let t0 = Number(lsGet(key)) || 0, timer = 0, sending = false;
  const m = document.createElement('div'); m.id = 'issueModal'; document.body.appendChild(m);
  const close = () => { clearInterval(timer); closeIssue(); };
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const draw = (done) => {
    if (done) { m.innerHTML = '<div class="box"><h3>Listo, avisamos a administración</h3><p>Administración va a llamar al cliente y al restaurante. Quédate cerca del domicilio. Cuando te den un <b>código de liberación</b>, toca <b>"Tengo un código de administración"</b> en tu pedido. Se te paga el envío.</p><button class="btn primary" type="button" id="naClose">Cerrar</button></div>'; document.getElementById('naClose').addEventListener('click', close); return; }
    const left = t0 ? t0 + wait - Date.now() : wait, ready = t0 && left <= 0;
    m.innerHTML = '<div class="box"><h3>📵 Ya llegué y no sale el cliente</h3>' +
      (!t0 ? '<p>Antes de avisar, espera en el domicilio <b>' + Math.round(wait / 60000) + ' minutos</b> e intenta llamar o escribir por WhatsApp al cliente. Mantén tu GPS encendido.</p><label for="naPhone" style="font-weight:700;font-size:14px">Tu WhatsApp para que soporte te contacte</label><input id="naPhone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="10 dígitos" value="' + esc(lsGet('gasca_myphone') || '') + '" style="width:100%;box-sizing:border-box;min-height:48px;margin:6px 0 10px;padding:10px;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font-size:17px"><button class="btn primary" type="button" id="naStart">Empezar a esperar</button>'
        : ready ? '<p>Ya esperaste el tiempo. Si nadie contestó, avisa a administración. Se guardará tu ubicación para revisar el caso.</p><button class="btn primary" type="button" id="naSend"' + (sending ? ' disabled' : '') + '>' + (sending ? 'Enviando…' : 'Avisar a administración') + '</button>'
        : '<p>Espera aquí e intenta contactar al cliente.</p><div style="font-size:44px;font-weight:800;text-align:center;margin:8px 0" id="naLeft">' + fmt(left) + '</div><p class="inc-note">El botón para avisar se activa cuando termine el tiempo.</p>') +
      '<div class="err inc-note" id="naErr"></div><button class="btn ghost" type="button" id="naClose">Cerrar</button></div>';
    document.getElementById('naClose').addEventListener('click', close);
    const st = document.getElementById('naStart'); if (st) st.addEventListener('click', () => {
      const ph = (document.getElementById('naPhone').value || '').replace(/\D/g, '').slice(-10);
      if (ph.length !== 10) { const er = document.getElementById('naErr'); if (er) er.textContent = 'Escribe tu WhatsApp de 10 dígitos.'; return; }
      lsSet('gasca_myphone', ph); t0 = Date.now(); lsSet(key, String(t0)); draw();
    });
    const sd = document.getElementById('naSend'); if (sd) sd.addEventListener('click', send);
  };
  async function send() {
    if (sending) return; sending = true; draw();
    let gps = 'sin GPS';
    try { const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000, maximumAge: 20000 })); gps = 'GPS ' + p.coords.latitude.toFixed(5) + ',' + p.coords.longitude.toFixed(5); } catch (e) {}
    const nota = ('NO CONTESTAN · esperó ' + Math.round(wait / 60000) + ' min · ' + gps + ' · Tel ' + (lsGet('gasca_myphone') || '')).slice(0, 250), iid = newId();
    try {
      await setDoc(doc(db, 'incidencias', iid), { id: iid, orderId: id, driverId: S.uid, driverName: S.name || 'Repartidor', shop: o.shop || '', folio: folio(id), tipo: 'otro', nota, estado: 'abierta', creadoEn: Date.now() });
      lsSet(key, ''); lsSet('gasca_naSent_' + id, '1'); sending = false; clearInterval(timer); draw(true); render();
    } catch (e) { sending = false; draw(); const er = document.getElementById('naErr'); if (er) er.textContent = 'No se pudo enviar. Escríbenos por WhatsApp.'; }
  }
  draw();
  timer = setInterval(() => { if (!document.getElementById('issueModal')) { clearInterval(timer); return; } if (t0 && !sending) { const l = document.getElementById('naLeft'); const left = t0 + wait - Date.now(); if (left <= 0) draw(); else if (l) l.textContent = fmt(left); } }, 1000);
}
function askLiberar(id) {
  const o = byId(id);
  if (!o || o.estado !== 'asignado' || document.getElementById('issueModal')) return;
  const m = document.createElement('div'); m.id = 'issueModal'; document.body.appendChild(m);
  m.innerHTML = '<div class="box"><h3>🔓 Liberar pedido</h3><p>Pídele al repartidor su código de 4 números y escríbelo aquí. Así sabemos que es el repartidor correcto.</p><input id="lbIn" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="----"><div class="err" id="lbErr"></div><button class="btn primary" type="button" id="lbGo">Liberar</button><button class="btn ghost" type="button" id="lbNo">Cancelar</button></div>';
  const inp = document.getElementById('lbIn'); inp.focus(); inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); });
  document.getElementById('lbNo').addEventListener('click', closeIssue);
  document.getElementById('lbGo').addEventListener('click', async () => {
    const v = inp.value, er = document.getElementById('lbErr'); if (v.length !== 4) { er.textContent = 'Son 4 números.'; return; }
    const b = document.getElementById('lbGo'); b.disabled = true;
    try { await setDoc(doc(db, 'liberados', id), { shopId: S.uid, driverId: o.driverId || '', codigoIn: v, creadoEn: Date.now() }); S.libres = Object.assign({}, S.libres || {}, { [id]: o.driverId || '-' }); toast('Pedido liberado.'); closeIssue(); render(); }
    catch (e) { er.textContent = 'Código incorrecto. Revísalo con el repartidor.'; b.disabled = false; }
  });
}
async function adLiberar(id) {
  const o = byId(id); if (!o) return;
  try { await setDoc(doc(db, 'liberados', id), { driverId: o.driverId || '', shopId: o.shopId || '', porSoporte: true, creadoEn: Date.now() }); toast('Pedido liberado.'); }
  catch (e) { toast('No se pudo liberar.'); }
}
function askLib(id) {
  const o = byId(id);
  if (!canAct() || !o || o.driverId !== S.uid || o.estado !== 'recogido' || document.getElementById('issueModal')) return;
  const m = document.createElement('div'); m.id = 'issueModal'; document.body.appendChild(m);
  m.innerHTML = '<div class="box"><h3>🔑 Código de administración</h3><p>Escribe el código de 6 números que te dio administración para liberar este pedido.</p><input id="libIn" type="text" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="000000" style="width:100%;box-sizing:border-box;font-size:30px;text-align:center;letter-spacing:6px;padding:12px;border:2px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink)"><div class="err inc-note" id="libErr"></div><button class="btn primary" type="button" id="libGo">Liberar pedido</button><button class="btn ghost" type="button" id="libClose">Cancelar</button></div>';
  document.getElementById('libClose').addEventListener('click', closeIssue);
  document.getElementById('libIn').focus();
  document.getElementById('libGo').addEventListener('click', async () => {
    const code = document.getElementById('libIn').value.replace(/\D/g, ''), er = document.getElementById('libErr');
    if (code.length !== 6) { er.textContent = 'Son 6 números.'; return; }
    const btn = document.getElementById('libGo'); btn.disabled = true;
    const ok = await libDeliver(id, code);
    if (ok) closeIssue(); else { er.textContent = 'Código incorrecto o todavía no liberado. Pídelo a administración.'; btn.disabled = false; }
  });
}
async function libDeliver(id, code) {
  const o = byId(id);
  if (!canAct() || !o || o.driverId !== S.uid || o.estado !== 'recogido' || S.busy.has(id)) return false;
  S.busy.add(id);
  try {
    await runTransaction(db, async (tx) => {
      const oref = doc(db, 'orders', id), wref = doc(db, 'wallets', S.uid);
      const os = await tx.get(oref), ws = await tx.get(wref);
      const d = os.exists() ? os.data() : null;
      if (!d || d.estado !== 'recogido' || d.driverId !== S.uid || !ws.exists()) throw new Error('state');
      const com = (Number(d.tarifa) || 0) * COM_C, now = Date.now();
      tx.update(oref, { estado: 'entregado', entregadoEn: now, codigoIn: code, liberado: true });
      tx.update(wref, { saldoC: (Number(ws.data().saldoC) || 0) - com, lastOrder: id });
      tx.set(doc(db, 'movs', 'cm_' + id), { driverId: S.uid, tipo: 'comision', montoC: -com, orderId: id, creadoEn: now });
    });
    deliveredLocal(id, o); lsSet('gasca_naSent_' + id, '');
    toast('Pedido liberado por administración. Se descontó ' + cents(comC(o)) + ' de comisión.');
    S.busy.delete(id); render(); return true;
  } catch (e) { S.busy.delete(id); render(); return false; }
}
const newLibCode = () => { const a = new Uint32Array(1); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 4e9)); return String(100000 + (a[0] % 900000)); };
const incCode = (id, oid) => incAct(id, async () => {
  const o = byId(oid); if (!o || o.estado !== 'recogido' || !o.driverId) throw new Error('state');
  S.libs = S.libs || {};
  const ref = doc(db, 'liberaciones', oid), cur = await getDoc(ref);
  if (cur.exists() && cur.data().driverId === o.driverId) S.libs[oid] = cur.data().codigo;
  else { const c = newLibCode(); await setDoc(ref, { orderId: oid, driverId: o.driverId, codigo: c, creadoEn: Date.now(), incId: id }); S.libs[oid] = c; }
}, 'Código listo. Díctaselo al repartidor.');
function incDiv() {
  let el = document.getElementById('adminIncid');
  if (!el) { el = document.createElement('div'); el.id = 'adminIncid'; el.className = 'stack'; el.hidden = true; const ref = document.getElementById('adminSaldos'); ref.parentNode.insertBefore(el, ref.nextSibling); }
  return el;
}
function ordStatus(o) {
  if (!o) return { t: 'Pedido no encontrado', cls: '' };
  if (o.estado === 'cancelado') return { t: 'No entregado · Cancelado', cls: '' };
  if (o.estado === 'entregado' && o.liberado) return { t: 'No entregado · Liberado por administración', cls: 'abierto' };
  if (o.estado === 'entregado') return { t: 'Entregado con éxito', cls: 'entregado' };
  if (o.estado === 'recogido') return { t: 'En camino (el repartidor ya lo recogió)', cls: 'asignado' };
  if (o.estado === 'asignado') return { t: 'Asignado (va por el pedido)', cls: 'asignado' };
  return { t: 'Esperando repartidor', cls: 'abierto' };
}
function destParts(d) { const m = String(d || '').split(' — Ref: '); return { dir: m[0], ref: m[1] || '' }; }
function incOf(o) { return S.incs.filter((x) => x.orderId === o.id).sort((a, b) => b.creadoEn - a.creadoEn)[0]; }
function cleanNota(n) { return String(n || '').replace(/ ?· ?Tel \d{10}/, '').replace(/ ?· ?GPS [-\d.,]+/, '').replace(/^NO CONTESTAN · /, '').trim(); }
function noReason(o) {
  if (o.motivoNo) return o.motivoNo;
  const x = incOf(o), noans = x && NOANS_RE.test(x.nota || '');
  const prob = x ? (noans ? 'nadie contestó en la entrega' : String(INC_TIPOS[x.tipo] || x.tipo).toLowerCase()) : '';
  const nota = x && !noans ? cleanNota(x.nota) : '';
  const by = x && x.atendidaPor ? ' Atendió: ' + x.atendidaPor + '.' : '';
  if (o.estado === 'entregado' && o.liberado) return 'No se entregó al cliente: ' + (prob || 'sin respuesta en el domicilio') + '. Soporte liberó al repartidor para que se le registrara el viaje.' + (nota ? ' Nota del repartidor: ' + nota + '.' : '') + by;
  if (o.estado === 'cancelado') {
    if (x && o.driverId) return 'Soporte canceló el pedido tras el reporte del repartidor (' + prob + ').' + (nota ? ' Nota: ' + nota + '.' : '') + by;
    if (x) return 'Soporte canceló el pedido tras un reporte (' + prob + ').' + by;
    return o.driverId ? 'Pedido cancelado.' : 'Ningún repartidor tomó el pedido: el negocio lo canceló, cambió la oferta o se venció la espera.';
  }
  return '';
}
const byMe = () => ({ atendidaPor: (S.isAgent || S.isPartner) ? S.agentName : 'Dueño', atendidaPorEmail: S.email });
function orderBlock(o, x) {
  const st = ordStatus(o), dp = destParts(o && o.dest);
  return '<div class="subhead" style="margin:12px 0 4px">Datos del pedido</div>' +
    '<div class="line"><span class="k">Número de pedido</span><span class="v"><b>' + (o ? folio(o.id) : esc((x && x.folio) || '')) + '</b></span></div>' +
    '<div class="line"><span class="k">Negocio</span><span class="v">' + esc((o && o.shop) || (x && x.shop) || '') + '</span></div>' +
    (o ? '<div class="line"><span class="k">Dirección de entrega</span><span class="v">' + esc(dp.dir) + '</span></div>' : '') +
    (o && dp.ref ? '<div class="line"><span class="k">Referencia</span><span class="v">' + esc(dp.ref) + '</span></div>' : '') +
    (o && o.driverName ? '<div class="line"><span class="k">Repartidor</span><span class="v">' + esc(o.driverName) + '</span></div>' : '') +
    '<div class="line"><span class="k">Estado del pedido</span><span class="v"><b>' + esc(st.t) + '</b></span></div>' +
    (o && o.estado === 'asignado' ? (isRel(o) ? '<div class="line"><span class="k">Liberación</span><span class="v">✅ Liberado</span></div>' : '<button class="btn ghost small block" type="button" data-act="ad-lib" data-id="' + esc(o.id) + '">🔓 Liberar pedido (soporte)</button>') : '') +
    (o && (o.estado === 'cancelado' || (o.estado === 'entregado' && o.liberado)) ? '<div class="line"><span class="k">Por qué no se entregó</span><span class="v">' + esc(noReason(o)) + '</span></div>' : '');
}
function spDiv() {
  let el = document.getElementById('adminSoporte');
  if (!el) { el = document.createElement('div'); el.id = 'adminSoporte'; el.className = 'stack'; el.hidden = true; const ref = document.getElementById('adminSaldos'); ref.parentNode.insertBefore(el, ref.nextSibling); }
  return el;
}
function loadQR(cb) {
  if (window.qrcode) return cb(true);
  const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  sc.onload = () => cb(!!window.qrcode); sc.onerror = () => cb(false); document.head.appendChild(sc);
}
function qrSvg(text) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 3; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '" width="260" height="260" shape-rendering="crispEdges" role="img" aria-label="Código QR"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
const agLink = (email) => location.origin + location.pathname.replace(/index\.html$/, '') + '?soporte=' + encodeURIComponent(email);
function agQrBox(a) {
  const link = agLink(a.email);
  let svg = '';
  if (window.qrcode) { try { svg = qrSvg(link); } catch (e) { svg = ''; } }
  else if (!S.qrLoading) { S.qrLoading = true; loadQR((ok) => { S.qrLoading = false; S.qrFail = !ok; render(); }); }
  return '<div class="paynote" style="text-align:center"><b>Invitación para ' + esc(a.name) + '</b><br>' +
    (svg ? '<div style="margin:10px auto;width:260px;max-width:100%;background:#fff;padding:6px;border-radius:12px">' + svg + '</div><small>Pídele que escanee este código con la cámara de su celular.</small>' : '<small>' + (S.qrFail ? 'No se pudo dibujar el código QR. Usa el enlace de abajo.' : 'Preparando el código QR…') + '</small>') +
    '<div class="actions" style="margin-top:10px"><a class="btn primary small" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('Hola ' + a.name + ', este es tu acceso al equipo de Gasca. Ábrelo, crea tu contraseña y listo: ' + link) + '">Enviar por WhatsApp</a>' +
    '<button class="btn ghost small" type="button" data-act="ag-copy" data-e="' + esc(a.email) + '">Copiar enlace</button></div></div>';
}
function renderSoporte(el) {
  const allA = (S.agentes || []).slice().sort((a, b) => (a.creadoEn || 0) - (b.creadoEn || 0)), own = !S.isPartner;
  const ags = allA.filter((a) => a.rol !== 'socio'), socs = allA.filter((a) => a.rol === 'socio');
  const fld = (id, lb, ph, ty) => '<div class="field"><label for="' + id + '">' + lb + '</label><input id="' + id + '" type="' + ty + '" maxlength="80" placeholder="' + ph + '" autocomplete="off"></div>';
  let h = '<h2 class="section">Equipo de soporte</h2><p class="hint">Cada agente entra con su propio correo y contraseña. Todo lo que atiende queda guardado con su nombre en Incidencias.</p>';
  if (own) h += '<article class="order"><div class="subhead" style="margin:0 0 6px">Agregar un agente</div>' + fld('ag-name', 'Nombre del agente', 'Ej. María López', 'text') + fld('ag-mail', 'Correo del agente', 'correo@ejemplo.com', 'email') +
    '<button class="btn primary block" type="button" data-act="ag-add">Agregar agente</button>' +
    '<p class="hint">Al agregarlo te sale su <b>QR</b>. Él lo escanea, crea su contraseña, verifica su correo y ya queda dando soporte. No necesita buscar ningún botón.</p></article>' +
    '<article class="order"><div class="subhead" style="margin:0 0 6px">Agregar un socio administrador</div><p class="hint">Ve todo el panel (altas, recargas, saldos, soporte). No puede agregar ni quitar socios o agentes.</p>' + fld('sc-name', 'Nombre del socio', 'Ej. Juan Pérez', 'text') + fld('sc-mail', 'Correo del socio', 'correo@ejemplo.com', 'email') + '<button class="btn primary block" type="button" data-act="sc-add">Agregar socio</button></article>';
  const nOn = ags.filter((a) => Object.keys(S.presence || {}).some((k) => { const p = S.presence[k]; return p && (p.role === 'soporte' || p.role === 'socio') && p.name === a.email && Date.now() - (p.lastSeen || 0) < FRESH_MS; })).length;
  h += '<div class="subhead">Agentes (' + ags.length + ') · ' + nOn + ' conectado' + (nOn === 1 ? '' : 's') + '</div>';
  const card = (a) => {
    const mine = S.incs.filter((x) => x.estado !== 'abierta' && x.atendidaPorEmail === a.email);
    const last = mine.reduce((m, x) => Math.max(m, x.atendidaEn || 0), 0), on = a.activo !== false;
    const hoy = mine.filter((x) => isToday(x.atendidaEn)).length, cnt = (k) => mine.filter((x) => x.accion === k).length;
    const pp = Object.keys(S.presence || {}).map((k) => S.presence[k]).filter((p) => p && (p.role === 'soporte' || p.role === 'socio') && p.name === a.email).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0))[0];
    const here = !!pp && Date.now() - (pp.lastSeen || 0) < FRESH_MS;
    return '<article class="order"><div class="head"><span class="folio">' + esc(a.name) + '</span><span class="chip ' + (on ? 'entregado' : '') + '">' + (on ? 'Activo' : 'De baja') + '</span></div>' +
      '<div class="line"><span class="k">Conexión</span><span class="v"><b>' + (here ? '🟢 Conectado ahora' : '⚪ Sin conexión') + '</b>' + (!here && pp ? ' · última vez ' + ago(pp.lastSeen) : (!here ? ' · todavía no ha entrado' : '')) + '</span></div>' +
      '<div class="line"><span class="k">Correo</span><span class="v">' + esc(a.email) + '</span></div>' +
      '<div class="line"><span class="k">Incidencias atendidas</span><span class="v"><b>' + hoy + '</b> hoy · <b>' + mine.length + '</b> en total' + (last ? ' · la última ' + ago(last) : '') + '</span></div>' +
      (mine.length ? '<div class="line"><span class="k">Lo que hizo</span><span class="v">Liberó ' + cnt('liberado') + ' · Canceló ' + cnt('cancelado') + ' · Reasignó ' + cnt('reasignado') + ' · Marcó atendida ' + (cnt('atendida') + mine.filter((x) => !x.accion).length) + '</span></div>' : '') +
      (S.qrFor === a.email ? agQrBox(a) : '') +
      '<div class="actions"><button class="btn ghost small" type="button" data-act="ag-qr" data-e="' + esc(a.email) + '">' + (S.qrFor === a.email ? 'Ocultar QR' : '📲 QR / enlace') + '</button><button class="btn ghost small" type="button" data-act="ag-work" data-e="' + esc(a.email) + '">Ver su trabajo</button>' +
      (own ? '<button class="btn ' + (on ? 'danger' : 'primary') + ' small" type="button" data-act="ag-tog" data-e="' + esc(a.email) + '">' + (on ? 'Dar de baja' : 'Reactivar') + '</button>' : '') + '</div></article>';
  };
  h += ags.length ? ags.map(card).join('') : emptyBox('Todavía no hay agentes', own ? 'Agrega a tu primera persona de soporte arriba.' : 'El dueño todavía no agrega agentes.');
  h += '<div class="subhead">Socios administradores (' + socs.length + ')</div>' + (socs.length ? socs.map(card).join('') : '<p class="hint">Todavía no hay socios.</p>');
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
async function agAdd(pre, rol) {
  pre = pre || 'ag'; if (S.isPartner || S.isAgent) return;
  const name = ($('#' + pre + '-name').value || '').trim(), email = ($('#' + pre + '-mail').value || '').trim().toLowerCase();
  if (name.length < 2) { toast('Escribe el nombre del agente.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Escribe un correo válido.'); return; }
  try { await setDoc(doc(db, 'agentes', email), Object.assign({ email, name: name.slice(0, 60), activo: true, creadoEn: Date.now() }, rol ? { rol } : {})); $('#' + pre + '-name').value = ''; $('#' + pre + '-mail').value = ''; S.qrFor = email; render(); toast(rol ? 'Socio agregado. Abajo está su QR.' : 'Agente agregado. Ahí abajo está su QR.'); }
  catch (e) { toast('No se pudo. ¿Ya pegaste las reglas de soporte en Firebase?'); }
}
async function agTog(email) {
  const a = (S.agentes || []).find((x) => x.email === email); if (!a) return;
  try { await updateDoc(doc(db, 'agentes', email), { activo: a.activo === false }); toast(a.activo === false ? 'Agente reactivado.' : 'Agente dado de baja.'); } catch (e) { toast('No se pudo. Intenta de nuevo.'); }
}
function pedDiv() {
  let el = document.getElementById('adminPedidos');
  if (!el) { el = document.createElement('div'); el.id = 'adminPedidos'; el.className = 'stack'; el.hidden = true; const ref = document.getElementById('adminSaldos'); ref.parentNode.insertBefore(el, ref.nextSibling); }
  return el;
}
function pedGroups() {
  const openInc = new Set(S.incs.filter((x) => x.estado === 'abierta').map((x) => x.orderId));
  const g = { atender: [], exito: [], no: [] };
  S.orders.forEach((o) => {
    if (o.estado === 'cancelado' || (o.estado === 'entregado' && o.liberado)) g.no.push(o);
    else if (o.estado === 'entregado') g.exito.push(o);
    else g.atender.push(o);
  });
  const tm = (o) => o.entregadoEn || o.canceladoEn || o.creadoEn || 0;
  g.atender.sort((a, b) => (openInc.has(b.id) - openInc.has(a.id)) || b.creadoEn - a.creadoEn);
  g.exito.sort((a, b) => tm(b) - tm(a)); g.no.sort((a, b) => tm(b) - tm(a));
  return g;
}
function renderPedidos(el) {
  const g = pedGroups(), f = S.pedF || 'atender';
  const T = [['atender', '⏳ Por atender'], ['exito', '✅ Con éxito'], ['no', '🚫 No entregados']];
  const openInc = new Set(S.incs.filter((x) => x.estado === 'abierta').map((x) => x.orderId));
  let h = '<h2 class="section">Pedidos</h2><div class="actions" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">' +
    T.map((t) => '<button type="button" class="btn ' + (f === t[0] ? 'primary' : 'ghost') + ' small" data-act="ped-f" data-f="' + t[0] + '">' + t[1] + ' (' + g[t[0]].length + ')</button>').join('') + '</div>';
  const L = g[f].slice(0, 60);
  h += L.length ? L.map((o) => {
    const st = ordStatus(o), when = o.entregadoEn || o.canceladoEn || o.creadoEn;
    return '<article class="order"><div class="head"><span class="folio">' + folio(o.id) + '</span><span class="chip ' + st.cls + '">' + esc(st.t.split(' · ')[0]) + '</span><span class="ago">' + ago(when) + '</span></div>' +
      (openInc.has(o.id) ? '<div class="paynote">⚠️ Tiene una incidencia sin atender (entra a Incidencias).</div>' : '') +
      orderBlock(o, null).replace('<div class="subhead" style="margin:12px 0 4px">Datos del pedido</div>', '').replace(/<div class="line"><span class="k">Número de pedido<\/span>.*?<\/div>/, '') +
      (o.tarifa ? '<div class="line"><span class="k">Tarifa de envío</span><span class="v">' + pesos(o.tarifa) + '</span></div>' : '') + '</article>';
  }).join('') + (g[f].length > 60 ? '<p class="hint">Se muestran los 60 más recientes.</p>' : '')
    : emptyBox('Nada aquí', f === 'atender' ? 'No hay pedidos pendientes.' : f === 'exito' ? 'Todavía no hay pedidos entregados con éxito.' : 'No hay pedidos cancelados ni liberados.');
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
function renderIncid(el) {
  const fl = S.incAg || '';
  const list = S.incs.filter((x) => !fl || (fl === 'open' ? x.estado === 'abierta' : x.atendidaPorEmail === fl || (fl === 'dueno' && x.estado !== 'abierta' && x.atendidaPor === 'Dueño'))).sort((a, b) => (a.estado === b.estado ? b.creadoEn - a.creadoEn : (a.estado === 'abierta' ? -1 : 1)));
  let h = '<h2 class="section">Incidencias</h2>';
  if (!S.isAgent && (S.agentes || []).length) {
    const chip = (v, t) => '<button type="button" class="btn ' + (fl === v ? 'primary' : 'ghost') + ' small" data-act="inc-ag" data-e="' + esc(v) + '">' + esc(t) + '</button>';
    h += '<div class="actions" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">' + chip('', 'Todas') + chip('open', 'Sin atender') + chip('dueno', 'Dueño') + S.agentes.map((a) => chip(a.email, a.name)).join('') + '</div>';
  }
  if (!list.length) { el.innerHTML = h + emptyBox('Sin incidencias', 'Cuando un repartidor reporte un problema en un pedido, aparece aquí.'); return; }
  h += list.map((x) => {
    const o = byId(x.orderId), open = x.estado === 'abierta', busy = S.busy.has('in' + x.id);
    const live = o && (o.estado === 'asignado' || o.estado === 'recogido');
    const wa = supportUrl('').split('?')[0];
    return '<article class="order"><div class="head"><span class="folio">' + esc(x.driverName || 'Repartidor') + '</span><span class="chip ' + (open ? 'abierto' : 'entregado') + '">' + (open ? 'Sin atender' : 'Atendida') + '</span><span class="ago">' + ago(x.creadoEn) + '</span></div>' +
      (!open ? '<div class="line"><span class="k">Atendió</span><span class="v"><b>' + esc(x.atendidaPor || 'Sin registro (antes de soporte)') + '</b>' + (x.atendidaEn ? ' · ' + new Date(x.atendidaEn).toLocaleString('es-MX') : '') + ' · ' + esc({ liberado: 'Liberó el pedido', cancelado: 'Canceló el pedido', reasignado: 'Reasignó el pedido', atendida: 'Marcó atendida' }[x.accion] || 'Marcó atendida') + '</span></div>' : '') +
      '<div class="line"><span class="k">Problema</span><span class="v"><b>' + (NOANS_RE.test(x.nota || '') ? '📵 Nadie contesta en la entrega' : esc(INC_TIPOS[x.tipo] || x.tipo)) + '</b></span></div>' +
      (x.nota ? '<div class="line"><span class="k">Nota</span><span class="v">' + esc(x.nota) + noansMap(x.nota) + '</span></div>' : '') +
      (() => { const mt = /Tel (\d{10})/.exec(x.nota || ''); const du = S.users.find((u) => u.id === x.driverId), ut = du && /^Tel (\d{10})$/.exec(du.addr || ''), tt = mt ? mt[1] : (ut ? ut[1] : ''); return tt ? '<div class="links"><a href="' + esc(waUrl(tt)) + '" target="_blank" rel="noopener">💬 WhatsApp al repartidor</a><a href="tel:' + tt + '">📞 Llamar ' + tt + '</a></div>' : '<div class="line"><span class="k">Contacto</span><span class="v"><small>Este aviso no trae teléfono. Los nuevos avisos sí lo traen.</small></span></div>'; })() +
      orderBlock(o, x) +
      (S.libs && S.libs[x.orderId] && o && o.estado === 'recogido' ? '<div class="paynote">Código de liberación: <b style="font-size:26px;letter-spacing:4px">' + esc(S.libs[x.orderId]) + '</b><br><small>Díctaselo al repartidor después de hablar con el cliente y el restaurante.</small></div>' : '') +
      (o && o.liberado ? '<div class="line"><span class="k">Resultado</span><span class="v"><b>🔑 Pedido no entregado · Liberado por administración</b></span></div>' : '') +
      (open ? '<div class="actions">' +
        (o && o.estado === 'recogido' && o.driverId ? '<button class="btn primary small" type="button" data-act="inc-code" data-id="' + esc(x.id) + '" data-oid="' + esc(x.orderId) + '"' + (busy ? ' disabled' : '') + '>🔑 Código de liberación</button>' +
          '<button class="btn ghost small" type="button" data-act="inc-release" data-id="' + esc(x.id) + '" data-oid="' + esc(x.orderId) + '"' + (busy ? ' disabled' : '') + '>Liberar yo (sin código)</button>' : '') +
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
const incDone = (id) => incAct(id, () => updateDoc(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: Date.now(), accion: 'atendida', ...byMe() }), 'Incidencia atendida.');
const incReopen = (id, oid) => incAct(id, async () => {
  await updateDoc(doc(db, 'orders', oid), { estado: 'abierto', driverId: '', driverName: '', asignadoEn: null, recogidoEn: null });
  await updateDoc(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: Date.now(), accion: 'reasignado', ...byMe() });
}, 'Pedido liberado para otro repartidor.');
const incRelease = (id, oid) => incAct(id, async () => {
  const o = byId(oid); if (!o || o.estado !== 'recogido' || !o.driverId) throw new Error('state');
  const com = (Number(o.tarifa) || 0) * COM_C, now = Date.now(), b = writeBatch(db);
  b.update(doc(db, 'orders', oid), { estado: 'entregado', entregadoEn: now, liberado: true, liberadoMotivo: 'nadie contesto', liberadoPor: byMe().atendidaPor });
  b.update(doc(db, 'wallets', o.driverId), { saldoC: increment(-com) });
  b.set(doc(db, 'movs', 'cm_' + oid), { driverId: o.driverId, tipo: 'comision', montoC: -com, orderId: oid, creadoEn: now });
  b.update(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: now, accion: 'liberado', ...byMe() });
  await b.commit();
}, 'Pedido liberado como entregado. Se cobró la comisión.');
const incCancel = (id, oid) => incAct(id, async () => {
  const x = S.incs.find((i) => i.id === id), noans = x && NOANS_RE.test(x.nota || '');
  const mot = 'Soporte canceló el pedido tras el reporte del repartidor (' + (noans ? 'nadie contestó en la entrega' : String((x && (INC_TIPOS[x.tipo] || x.tipo)) || 'problema').toLowerCase()) + ').' + (x && !noans && cleanNota(x.nota) ? ' Nota: ' + cleanNota(x.nota) + '.' : '') + ' Atendió: ' + byMe().atendidaPor + '.';
  await updateDoc(doc(db, 'orders', oid), { estado: 'cancelado', canceladoEn: Date.now(), canceladoPor: 'soporte', motivoNo: mot.slice(0, 300) });
  await updateDoc(doc(db, 'incidencias', id), { estado: 'atendida', atendidaEn: Date.now(), accion: 'cancelado', ...byMe() });
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
  pk.closest('.field').insertAdjacentHTML('beforebegin', '<div id="pickTxt" class="sumbox" hidden></div>');
  pk.closest('.field').insertAdjacentHTML('afterend', '<div id="pickFields" hidden><div class="field sec-h"><label>Datos de recolección</label></div>' +
    f('p-calle', 'Calle y número', 'Ej. Av. Insurgentes 100', 70) + f('p-col', 'Colonia', 'Ej. Condesa', 50) + f('p-ciudad', 'Ciudad', 'Ej. Tepic', 40) + f('p-mun', 'Municipio', 'Ej. Tepic', 40) + '</div>');
  $('#p-ciudad').value = lsGet('gasca_pciudad') || lsGet('gasca_ciudad'); $('#p-mun').value = lsGet('gasca_pmun') || lsGet('gasca_mun');
})();
(function () {
  const old = document.getElementById('o-dest'); if (!old) return;
  const box = old.closest('.field'); old.required = false; box.hidden = true;
  const f = (id, label, ph, max, req, extra) => '<div class="field"' + (extra || '') + '><label for="' + id + '">' + label + (req ? '' : ' (opcional)') + '</label><input id="' + id + '" type="text" maxlength="' + max + '"' + (req ? ' required' : '') + ' placeholder="' + ph + '"></div>';
  box.insertAdjacentHTML('beforebegin',
    '<div class="field sec-h"><label>Datos de entrega</label></div>' +
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
    '<div id="cliEq" hidden><div class="field sec-h"><label>¿En qué lo llevamos?</label></div><div class="roles" style="grid-template-columns:1fr">' +
    card('ceq', 'm', '🎒 Mochila', 'Para cosas ligeras: platos de comida, ropa, paquetes chicos.') + card('ceq', 'c', '📦 Caja plástica', 'Una caja de plástico para cosas pesadas o que no van en mochila: herramientas, una sierra, carne, una bolsa de clavos. No es caja de cartón ni de madera.') + card('ceq', 'a', '🤷 Cualquiera de las dos', 'Da igual si es mochila o caja plástica.', true) + '</div></div>' +
    '<div id="cliPay" hidden><div class="field sec-h"><label>¿Hay una venta de por medio?</label></div><div class="roles" style="grid-template-columns:1fr">' +
    card('ctipo', 'e', 'No, solo es un envío', 'Por ejemplo, un martillo prestado.', true) +
    card('ctipo', 'v', 'Sí, me pagan al recoger', 'El repartidor te paga el producto al recoger y lo cobra a quien recibe.') +
    card('ctipo', 'p', 'Sí, pero ya me pagaron', 'Por ejemplo, por transferencia. El repartidor no cobra el producto.') + '</div>' +
    '</div>' +
    '<div id="cliQuien" hidden><div class="field sec-h"><label>¿Quién paga el mandadito?</label></div><div class="roles" style="grid-template-columns:1fr">' +
    card('cquien', 'e', 'Paga quien envía', 'Tú le pagas al repartidor.') + card('cquien', 'r', 'Paga quien recibe', 'Se lo cobra el repartidor al entregar.', true) + '</div></div>' +
    '<div class="field" id="fProd" hidden style="margin-top:12px"><label for="o-prod">Valor del producto</label><input id="o-prod" type="number" inputmode="decimal" min="0" step="any" placeholder="$ precio del producto"><p class="hint" style="margin:6px 0 0">Solo si hay una venta. Si es un envío sin costo, déjalo vacío.</p></div>');
  pair.insertAdjacentHTML('beforebegin', '<p id="minNote" class="paynote" hidden></p>');
  pair.insertAdjacentHTML('afterend', '<div id="paySum" class="sumbox" hidden></div>');
  const f = $('#orderForm'); f.addEventListener('input', cliSum); f.addEventListener('change', cliSum); cliSum();
  const st = document.createElement('style');
  st.textContent = '.sumbox{margin:14px 0;padding:14px;border:2px dashed var(--line);border-radius:14px;background:var(--surface);line-height:1.5}.paynote{margin:10px 0;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--accent) 16%,var(--surface));line-height:1.45;font-size:15px}';
  document.head.appendChild(st);
})();
(function () { const h = document.querySelector('#shopNew h2.section'); if (h) h.textContent = 'Generar pedido'; })();
(function () {
  const st = document.createElement('style');
  st.textContent = '.top{flex-wrap:wrap;row-gap:10px}.who{order:3;flex:1 1 100%;max-width:100%!important;display:flex;align-items:center;gap:9px;text-align:left;white-space:normal!important;padding:8px 14px!important;border-radius:14px!important;font-size:14px;line-height:1.25}' +
    '.who::before{content:"";flex:0 0 9px;height:9px;border-radius:50%;background:var(--green,#17803F)}.who::after{content:"Salir";margin-left:auto;padding-left:10px;font-size:13px;font-weight:700;color:var(--muted);text-decoration:underline}';
  document.head.appendChild(st);
})();

(function () {
  const tr = document.getElementById('riderTrips'); if (!tr) return;
  tr.insertAdjacentHTML('afterend', '<div id="riderSum" class="stack" hidden></div>');
  const st = document.createElement('style');
  st.textContent = '.radar{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:26px 16px 18px;margin-bottom:10px}.radar b{font-family:var(--font-display);font-size:26px;font-weight:700;margin-top:10px}.radar small{color:var(--muted);font-size:15px}' +
    '.radar .rings{position:relative;width:180px;height:180px;display:grid;place-items:center}.radar .rings i{position:absolute;inset:0;border:3px solid var(--accent);border-radius:50%;opacity:0;transform:scale(.3)}' +
    '.radar.on .rings i{animation:rdp 3s ease-out infinite}.radar.on .rings i:nth-child(2){animation-delay:1s}.radar.on .rings i:nth-child(3){animation-delay:2s}' +
    '.radar .sweep{position:absolute;inset:14px;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 70%,color-mix(in srgb,var(--accent) 55%,transparent) 100%);opacity:0}.radar.on .sweep{opacity:1;animation:rds 2.4s linear infinite}' +
    '.radar .core{position:relative;width:70px;height:70px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;box-shadow:0 4px 14px rgba(0,0,0,.18)}.radar:not(.on) .core{background:var(--surface2);color:var(--muted);box-shadow:none}' +
    '.radar.mini{padding:12px 16px 8px}.radar.mini .rings{width:110px;height:110px}.radar.mini .core{width:48px;height:48px}.radar.mini .core svg{width:22px;height:22px}.radar.mini b{font-size:22px;margin-top:4px}' +
    '@keyframes rdp{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.15);opacity:0}}@keyframes rds{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.radar .rings i,.radar .sweep{animation:none!important}}';
  document.head.appendChild(st);
})();

(function () {
  const st = document.createElement('style');
  st.textContent = '.tabs-in[data-n="4"] .tab{font-size:14px;padding-inline:4px;gap:5px;white-space:nowrap}.tabs-in[data-n="4"] .badge{min-width:18px;height:18px;font-size:11px;padding:0 4px}';
  document.head.appendChild(st);
})();

/* ---------- alerta fuerte, repetida, y modo "al pendiente" ---------- */
(function () {
  let lastSheet = null, ringT = null, keep = null, titleT = null;
  const baseTitle = document.title;
  function ring() { ensureAudio(); beep([988, 1319, 988, 1319]); buzz(); }
  function notify(txt) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted' || lsGet('gasca_notif') === '0') return;
      const opts = { body: txt, tag: 'gasca-pedido', renotify: true, vibrate: [300, 150, 300, 150, 300], icon: 'icon-192.png' };
      if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then((r) => r.showNotification('🛵 Gasca: pedido nuevo', opts)).catch(() => { try { new Notification('🛵 Gasca: pedido nuevo', opts); } catch (e) {} });
      else new Notification('🛵 Gasca: pedido nuevo', opts);
    } catch (e) {}
  }
  function startKeep() {
    try {
      ensureAudio();
      if (keep || !S.ac) return;
      const o = S.ac.createOscillator(), g = S.ac.createGain();
      g.gain.value = 0.00001; o.frequency.value = 30; o.connect(g); g.connect(S.ac.destination); o.start();
      keep = o;
    } catch (e) {}
  }
  function stopKeep() { try { if (keep) keep.stop(); } catch (e) {} keep = null; }
  setInterval(() => {
    const on = !!S.online && view() === 'rider';
    if (on) startKeep(); else stopKeep();
    const cur = on ? S.sheetId : null;
    if (cur && cur !== lastSheet) {
      ring(); clearInterval(ringT); const t0 = Date.now(); ringT = setInterval(() => { if (S.sheetId && Date.now() - t0 < 45000) ring(); else { clearInterval(ringT); ringT = null; } }, 3000);
      if (document.hidden) {
        notify('Toca para ver el pedido y aceptarlo.');
        clearInterval(titleT); let k = 0;
        titleT = setInterval(() => { document.title = (k++ % 2 ? baseTitle : '🔔 ¡PEDIDO NUEVO!'); if (!document.hidden || k > 60) { clearInterval(titleT); document.title = baseTitle; } }, 800);
      }
    }
    if (!cur && ringT) { clearInterval(ringT); ringT = null; }
    lastSheet = cur;
  }, 1000);
  // pedir permiso de avisos con un toque del repartidor (el navegador lo exige)
  document.addEventListener('click', (e) => {
    try {
      if (e.target.closest && e.target.closest('[data-act="online"]') && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch (er) {}
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = baseTitle; ensureAudio(); } });
})();

/* nombre y WhatsApp del cliente van dentro de "Datos de entrega" */
(function () {
  const c = document.getElementById('o-cliente'), t = document.getElementById('o-tel'), calle = document.getElementById('o-calle');
  if (!c || !t || !calle) return;
  const head = calle.closest('.field').previousElementSibling; // título "Datos de entrega"
  if (!head || !head.classList.contains('sec-h')) return;
  head.after(c.closest('.field'), t.closest('.field'));
})();

/* ---------- asistente paso a paso para generar pedidos ---------- */
const WZ_POT = '<svg width="30" height="30" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-5px"><circle cx="16" cy="6.5" r="2"/><path d="M4 23a12 12 0 0 1 24 0"/><path d="M2.5 23h27"/><path d="M5 27h22"/><path d="M9 17.5a8 8 0 0 1 5-4"/></svg>';
const WZ = { step: 0, key: '', steps: [], all: [] };
const wzOff = () => lsGet('gasca_nowiz') === '1';
const wzF = (id) => { const e = document.getElementById(id); return e ? e.closest('.field') : null; };
function wzLoad(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }
const wzCliKey = () => 'gasca_wz_cli_' + S.uid, wzLastKey = () => 'gasca_wz_last_' + S.uid;
const WZ_ADDR = ['o-cliente', 'o-tel', 'o-calle', 'o-num', 'o-int', 'o-col', 'o-ciudad', 'o-mun', 'o-ref'];
function wzSave() {
  const c = {}; WZ_ADDR.forEach((i) => { c[i] = ($('#' + i).value || '').trim(); });
  if (c['o-cliente']) {
    const list = (wzLoad(wzCliKey()) || []).filter((x) => !(x['o-tel'] === c['o-tel'] && x['o-calle'] === c['o-calle'] && x['o-num'] === c['o-num']));
    list.unshift(c); lsSet(wzCliKey(), JSON.stringify(list.slice(0, 8)));
  }
  const last = Object.assign({}, c);
  ['o-desc', 'o-tarifa', 'o-cobro', 'o-prod', 'p-calle', 'p-col', 'p-ciudad', 'p-mun'].forEach((i) => { last[i] = ($('#' + i).value || '').trim(); });
  last.ctipo = (document.querySelector('input[name=ctipo]:checked') || {}).value || 'e';
  last.cquien = (document.querySelector('input[name=cquien]:checked') || {}).value || 'r';
  last.ceq = (document.querySelector('input[name=ceq]:checked') || {}).value || 'a';
  lsSet(wzLastKey(), JSON.stringify(last));
}
function wzFill(o, ids) {
  ids.forEach((i) => { if (o[i] !== undefined && $('#' + i)) { $('#' + i).value = o[i]; $('#' + i).dispatchEvent(new Event('input', { bubbles: true })); } });
}
function wzBuild() {
  const cli = isCli(S.profile);
  const addr = [wzF('o-calle'), $('#o-num').parentElement.parentElement, wzF('o-col'), wzF('o-ciudad'), wzF('o-mun'), wzF('o-ref')];
  const who = [wzF('o-cliente'), wzF('o-tel'), $('#wzFreq')];
  const pair = $('#orderForm .pair'), btn = $('#orderBtn'), sum = $('#wzSum'), pk = wzF('o-pick');
  const pay = [pair, $('#minNote')];
  WZ.steps = cli ? [
    { t: '📦 ¿Qué vas a enviar?', h: 'Por ejemplo: un martillo, zapatos escolares, un paquete.', e: [wzF('o-desc'), $('#wzLast')] },
    { t: '🛵 ¿En qué lo llevamos?', h: 'Elige mochila (cosas ligeras) o caja plástica (cosas pesadas). Así el repartidor sabe si puede ir.', e: [$('#cliEq')] },
    { t: '🛍️ ¿Hay una venta de por medio?', h: 'Elige una opción. Si el repartidor tiene que pagar o cobrar un producto, aquí lo indicas.', e: [$('#cliPay'), $('#fProd')], chk: 'v' },
    { t: '💵 ¿Quién paga el mandadito?', h: 'Y cuánto ofreces. Los repartidores pueden aceptar tu oferta o proponerte otra.', e: [$('#cliQuien')].concat(pay), chk: 'o' },
    { t: '📍 ¿Dónde lo recogemos?', h: 'La dirección de donde el repartidor va a recoger.', e: [$('#pickFields')] },
    { t: '🙋 ¿A quién se lo entregamos?', h: 'Nombre y WhatsApp de quien lo recibe. Si ya le has enviado antes, tócalo abajo.', e: who },
    { t: '🏠 ¿A qué dirección se lleva el pedido?', h: 'La dirección de quien lo recibe, a donde el repartidor va a entregar. Mientras más claro, más rápido llega.', e: addr },
    { t: '✅ Revisa tu pedido', h: 'Si todo está bien, toca Generar pedido.', e: [sum, $('#paySum'), btn], last: true }
  ] : [
    { t: '¿Qué se entrega?', ic: WZ_POT, h: 'Por ejemplo: 2 pizzas grandes y 1 refresco.', e: [wzF('o-desc'), $('#wzLast')] },
    { t: '🙋 ¿A quién se lo entregamos?', h: 'Nombre y WhatsApp de tu cliente. Si ya le has enviado antes, tócalo abajo.', e: who },
    { t: '🏠 ¿A qué dirección se lleva el pedido?', h: 'La dirección de tu cliente, a donde el repartidor va a entregar. Mientras más claro, más rápido llega.', e: addr },
    { t: '💵 ¿Cuánto se cobra?', h: 'Si el cliente ya pagó, deja "Cobrar al cliente" vacío.', e: pay },
    { t: '✅ Revisa tu pedido', h: 'Si todo está bien, toca Generar pedido.', e: [sum, (S.addr ? $('#pickTxt') : pk), btn], last: true }
  ];
  WZ.all = [];
  WZ.steps.forEach((st) => st.e.forEach((x) => { if (x && WZ.all.indexOf(x) < 0) WZ.all.push(x); }));
  [wzF('o-calle').previousElementSibling, pk, $('#pickTxt'), $('#paySum'), $('#cliEq'), $('#cliPay'), $('#cliQuien'), $('#fProd'), $('#pickFields'), $('#minNote')].forEach((x) => { if (x && WZ.all.indexOf(x) < 0) WZ.all.push(x); });
}
function wzSumHtml() {
  const cli = isCli(S.profile), row = (k, v, n) => '<div class="line"><span class="k">' + k + '</span><span class="v">' + esc(v) + ' <a href="#" data-wzgo="' + n + '">Cambiar</a></span></div>';
  const n = (i) => i; let h = '<div class="sumbox wzsum"><b>Tu pedido</b>';
  if (cli) h += row('Lleva', val('o-desc'), 0) + row('Va en', ({ m: '🎒 Mochila', c: '📦 Caja plástica', a: '🤷 Cualquiera de las dos' })[(document.querySelector('input[name=ceq]:checked') || {}).value || 'a'], 1) + row('Recoger en', buildPick(), 4) + row('Entregar a', val('o-cliente') + ' · ' + val('o-tel') + ' · ' + buildDest(), 5);
  else h += row('Lleva', val('o-desc'), 0) + row('Entregar a', val('o-cliente') + ' · ' + val('o-tel') + ' · ' + buildDest(), 1) +
    row('Cobrar al cliente', Number($('#o-cobro').value) > 0 ? pesos(Number($('#o-cobro').value)) : 'Ya pagó', 3) + row('Pago al repartidor', pesos(Number($('#o-tarifa').value) || 0), 3);
  return h + '</div>';
}
function wzValid(i) {
  const st = WZ.steps[i];
  for (const el of st.e) {
    if (!el || el.hidden || el.closest('[hidden]')) continue;
    for (const inp of el.querySelectorAll('input:not([type=radio]),textarea')) {
      if (inp.closest('[hidden]')) continue;
      if (!inp.checkValidity()) { inp.reportValidity(); try { inp.focus(); } catch (e) {} return false; }
    }
  }
  if (st.chk === 'v') {
    const tp = (document.querySelector('input[name=ctipo]:checked') || {}).value;
    if (tp === 'v' && !(Number($('#o-prod').value) > 0)) { toast('Escribe cuánto cuesta el producto.'); return false; }
  }
  if (st.chk === 'o' && S.minOffer && (Math.round(Number($('#o-tarifa').value) || 0) < S.minOffer)) { toast('Tu oferta debe ser de ' + pesos(S.minOffer) + ' o más.'); return false; }
  return true;
}
function wzGo(n) { WZ.step = Math.max(0, Math.min(WZ.steps.length - 1, n)); WZ.dirty = true; wzSync(); try { window.scrollTo(0, 0); } catch (e) {} }
function wzFreqHtml() {
  const l = wzLoad(wzCliKey()) || [];
  return l.length ? '<small class="wzlab">Clientes frecuentes</small><div class="wzchips">' + l.map((c, i) => '<button type="button" class="wzchip" data-wzcli="' + i + '">' + esc(c['o-cliente']) + '<small>' + esc(c['o-calle'] || '') + '</small></button>').join('') + '</div>' : '';
}
function wzInit() {
  const f = $('#orderForm'); if (!f || f.dataset.wz) return;
  f.dataset.wz = '1';
  f.insertAdjacentHTML('afterbegin', '<div id="wzTop"><div class="wz-bar"><i id="wzBar"></i></div><div class="wz-n" id="wzN"></div><h3 id="wzTitle"></h3><p id="wzHint" class="hint"></p></div>');
  f.insertAdjacentHTML('beforeend', '<div id="wzNav"><button type="button" class="btn ghost" id="wzBack">Atrás</button><button type="button" class="btn primary" id="wzNext">Siguiente</button></div>');
  const btn = $('#orderBtn');
  ($('#paySum') || btn).insertAdjacentHTML('beforebegin', '<div id="wzSum"></div>');
  wzF('o-cliente').insertAdjacentHTML('beforebegin', '<div id="wzFreq"></div>');
  wzF('o-desc').insertAdjacentHTML('afterend', '<div id="wzLast"></div>');
  const st = document.createElement('style');
  st.textContent = '.wz-on .wz-off{display:none!important}.wz-on .sec-h{display:none!important}.wz-on .sumbox{margin:8px 0!important;padding:10px 14px!important}#wzSum:empty{display:none}.wz-bar{height:8px;background:var(--line,#dde3ea);border-radius:99px;overflow:hidden}.wz-bar i{display:block;height:100%;background:#f6b400;border-radius:99px;transition:width .3s}.wz-n{margin:8px 0 4px;font-weight:700;opacity:.65;font-size:14px}#wzTitle{font-size:24px;line-height:1.2;margin:6px 0 4px}#wzHint{margin:0 0 16px}#wzNav{display:flex;gap:10px;margin-top:16px}#wzNav .btn{flex:1;min-height:52px;font-size:17px}.wzchips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 14px}.wzchip{border:2px solid var(--line,#cfd6de);background:#fff;color:#17212b;border-radius:14px;padding:8px 12px;font-weight:700;text-align:left;min-height:48px}.wzchip small{display:block;font-weight:400;opacity:.65}.wzlab{display:block;font-weight:700;opacity:.7;margin-top:4px}.wzsum a{margin-left:6px;font-weight:700}#wzLast .btn{margin:12px 0}#wzDone{position:fixed;inset:0;z-index:60;background:var(--bg,#eef1f5);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}#wzDone .btn{width:100%;max-width:320px;min-height:52px;font-size:17px}#wzDone h2{margin:0;font-size:26px}.wzoffer{color:#16202a;background:#fff;border:3px solid #1f9d55;border-radius:22px;padding:14px 16px;box-shadow:0 10px 26px rgba(31,157,85,.3);animation:wzpop .35s cubic-bezier(.2,1.3,.3,1) both;margin-bottom:10px}.wzoffer small{display:block;font-size:16px;font-weight:700}.wzoffer b{display:block;font-size:46px;line-height:1.1;color:#1f9d55;margin:4px 0 10px}.wzoa{display:flex;gap:10px}.wzoa .btn{flex:1;white-space:nowrap;min-height:52px;font-size:17px;font-weight:800}@keyframes wzpop{from{transform:scale(.8);opacity:0}to{transform:none;opacity:1}}#wzDone .radar{margin:0 auto}';
  document.head.appendChild(st);
  f.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target : null; if (!t || wzOff()) return;
    if (t.closest('#wzNext')) { if (wzValid(WZ.step)) wzGo(WZ.step + 1); }
    else if (t.closest('#wzBack')) { if (WZ.step === 0) { S.tab = 'pedidos'; S.cancelId = null; render(); try { window.scrollTo(0, 0); } catch (er) {} } else wzGo(WZ.step - 1); }
    else if (t.closest('[data-wzgo]')) { e.preventDefault(); wzGo(Number(t.closest('[data-wzgo]').getAttribute('data-wzgo'))); }
    else if (t.closest('[data-wzcli]')) {
      const c = (wzLoad(wzCliKey()) || [])[Number(t.closest('[data-wzcli]').getAttribute('data-wzcli'))];
      if (c) { wzFill(c, WZ_ADDR); toast('Listo: datos de ' + c['o-cliente'] + '.'); wzGo(WZ.step + 1); }
    } else if (t.closest('#wzRepeat')) {
      const l = wzLoad(wzLastKey()); if (!l) return;
      wzFill(l, WZ_ADDR.concat(['o-desc', 'o-tarifa', 'o-cobro', 'o-prod', 'p-calle', 'p-col', 'p-ciudad', 'p-mun']));
      ['ctipo', 'cquien', 'ceq'].forEach((n) => { const r = document.querySelector('input[name=' + n + '][value=' + (l[n] || (n === 'ceq' ? 'a' : 'e')) + ']'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } });
      toast('Listo: repetí tu último pedido. Revísalo.'); wzGo(WZ.steps.length - 1);
    }
  });
  f.addEventListener('submit', (e) => {
    if (wzOff()) return;
    if (WZ.step < WZ.steps.length - 1) { e.preventDefault(); e.stopImmediatePropagation(); if (wzValid(WZ.step)) wzGo(WZ.step + 1); return; }
    for (let i = 0; i < WZ.steps.length - 1; i++) if (!wzValid(i)) { e.preventDefault(); e.stopImmediatePropagation(); wzGo(i); return; }
  }, true);
}
function wzMenuVis() {
  const w = $('#who'); if (!w) return;
  const hide = !!S.user && view() === 'shop' && S.tab === 'nuevo' && !!$('#shopNew') && !$('#shopNew').hidden && !!$('#orderForm') && $('#orderForm').classList.contains('wz-on') && WZ.step > 0;
  w.classList.toggle('wz-nomenu', hide);
}
function wzSync() {
  const f = $('#orderForm');
  if (!f || !S.profile || view() !== 'shop' || $('#shopNew').hidden) return;
  wzInit();
  if (wzOff()) { f.classList.remove('wz-on'); f.noValidate = false; WZ.all.forEach((x) => x && x.classList.remove('wz-off')); ['wzTop', 'wzNav', 'wzSum', 'wzFreq', 'wzLast'].forEach((i) => { const e = $('#' + i); if (e) e.hidden = true; }); return; }
  ['wzTop', 'wzNav', 'wzSum', 'wzFreq', 'wzLast'].forEach((i) => { const e = $('#' + i); if (e) e.hidden = false; });
  const key = isCli(S.profile) ? 'c' : 's';
  if (key !== WZ.key || !WZ.steps.length) { WZ.key = key; WZ.step = 0; wzBuild(); WZ.dirty = true; }
  f.classList.add('wz-on'); f.noValidate = true;
  const st = WZ.steps[WZ.step], n = WZ.steps.length;
  WZ.all.forEach((x) => { if (x) x.classList.toggle('wz-off', st.e.indexOf(x) < 0); });
  $('#wzBar').style.width = Math.round(((WZ.step + 1) / n) * 100) + '%';
  $('#wzN').textContent = 'Paso ' + (WZ.step + 1) + ' de ' + n;
  $('#wzTitle').innerHTML = (st.ic ? st.ic + ' ' : '') + esc(st.t); $('#wzHint').textContent = st.h;
  wzMenuVis();
  $('#wzBack').hidden = WZ.step === 0; $('#wzBack').textContent = 'Atrás'; $('#wzNext').hidden = !!st.last;
  const btn = $('#orderBtn'); if (!btn.disabled) btn.textContent = 'Generar pedido';
  if (WZ.dirty) {
    WZ.dirty = false;
    if (st.last) $('#wzSum').innerHTML = wzSumHtml(); else $('#wzSum').innerHTML = '';
    $('#wzFreq').innerHTML = wzFreqHtml();
    $('#wzLast').innerHTML = '';
  }
}
let wzDoneT = null, wzOfSig = '';
function wzDone(id) {
  if (wzOff()) return;
  WZ.step = 0; WZ.dirty = true;
  const old = document.getElementById('wzDone'); if (old) old.remove();
  clearInterval(wzDoneT); wzOfSig = '';
  const t0 = Date.now(), pers = (() => { const o = byId(id); return o ? isP(o) : isCli(S.profile); })();
  const d = document.createElement('div'); d.id = 'wzDone';
  d.innerHTML = '<div class="radar on" aria-hidden="true"><div class="rings"><i></i><i></i><i></i><span class="sweep"></span><span class="core">🛵</span></div></div><h2 id="wzDoneT">Buscando repartidor…</h2><p class="hint" id="wzDoneS">Pedido ' + esc(folio(id)) + '</p><div id="wzOf" style="width:100%;max-width:340px"></div>' +
    (pers ? '<p class="paynote" id="wzDoneC" style="margin:0">Tiempo para que alguien la tome: <b id="wzCd">…</b> s</p>' : '') +
    '<button type="button" class="btn ghost" data-wzd="ver">Ir a mis pedidos</button><button type="button" class="btn ghost" data-wzd="cancel" style="color:var(--red)">Cancelar pedido</button>';
  document.body.appendChild(d);
  const close = (toast2, tab) => { clearInterval(wzDoneT); wzDoneT = null; d.remove(); S.tab = tab || 'pedidos'; if (toast2) toast(toast2); render(); };
  d.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-wzd]'); if (!b) return;
    if (b.getAttribute('data-wzd') === 'cancel') { if (confirm('¿Cancelar este pedido?')) { cancelOrder(id); close(); } return; }
    close();
  });
  let miss = 0;
  wzDoneT = setInterval(() => {
    if (view() !== 'shop') { if (++miss < 10) return; clearInterval(wzDoneT); wzDoneT = null; d.remove(); return; } miss = 0;
    const o = byId(id);
    if (!o) { if (Date.now() - t0 > 6000) close(); return; }
    if (o.estado === 'asignado' || o.estado === 'recogido' || o.estado === 'entregado') {
      clearInterval(wzDoneT); beep([660, 990]);
      $('#wzDoneT').textContent = '¡' + (o.driverName || 'Un repartidor') + ' tomó tu pedido!'; $('#wzDoneS').textContent = 'Ya va por él.';
      const c = $('#wzDoneC'); if (c) c.remove();
      setTimeout(() => { if (document.getElementById('wzDone') === d) close(); }, 2500); return;
    }
    if (o.estado === 'cancelado') { close(); return; }
    { const offs = S.ofertas.filter((x) => x.orderId === id && x.estado === 'pendiente').sort((a, b) => a.monto - b.monto).slice(0, 3);
      const sig = offs.map((x) => x.id + (S.busy.has('oy' + x.id) ? 'b' : '')).join('|');
      if (sig !== wzOfSig) {
        const isNew = offs.some((x) => wzOfSig.indexOf(x.id) < 0);
        wzOfSig = sig;
        $('#wzOf').innerHTML = offs.map((x) => '<div class="wzoffer"><small>🛵 ' + esc(x.driverName) + ' te ofrece hacerlo por</small><b>' + pesos(x.monto) + '</b><div class="wzoa"><button type="button" class="btn ghost" data-act="of-no" data-oid="' + esc(x.id) + '">No, gracias</button><button type="button" class="btn primary" data-act="of-yes" data-oid="' + esc(x.id) + '"' + (S.busy.has('oy' + x.id) ? ' disabled' : '') + '>✔ Aceptar</button></div></div>').join('');
        $('#wzDoneT').textContent = offs.length ? '¡Tienes una oferta!' : 'Buscando repartidor…';
        if (isNew) { try { ensureAudio(); beep([784, 988, 1175]); buzz(); } catch (e) {} }
      }
    }
    if (isExpired(o)) { try { beep([440, 330]); } catch (e) {} close(); return; }
    const c = $('#wzCd'); if (c) c.textContent = Math.max(0, Math.ceil((deadline(o) - Date.now()) / 1000));
  }, 400);
}
setInterval(wzSync, 400);

/* Respaldo: si la conexión en vivo se duerme (pantalla apagada, otra app), el solicitante revisa sus pedidos cada 12 s y al volver a la app. */
(function () {
  let busy = false;
  async function poll() {
    if (busy || S.role !== 'shop' || !S.roleOn || view() !== 'shop' || document.hidden) return;
    if (!S.myOrders.some((o) => o.estado === 'abierto' || o.estado === 'asignado' || o.estado === 'recogido')) return;
    busy = true;
    try { const snap = await getDocs(query(collection(db, 'orders'), where('shopId', '==', S.uid))); if (view() === 'shop') onShopOrders(snap); } catch (e) {}
    busy = false;
  }
  setInterval(poll, 12000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(poll, 400); });
  window.addEventListener('online', () => setTimeout(poll, 400));
})();

/* ---------- aviso animado: "tu pedido fue entregado" ---------- */
const DELIV_SVG = '<svg viewBox="0 0 120 70" width="96" height="56" aria-hidden="true"><g class="dv-lines" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".35"><path d="M2 28h14"/><path d="M6 38h12"/><path d="M0 48h10"/></g><g class="dv-bike">' +
  '<g class="dv-wheel" style="transform-origin:34px 54px"><circle cx="34" cy="54" r="11" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M34 45v18M25 54h18" stroke="currentColor" stroke-width="2"/></g>' +
  '<g class="dv-wheel" style="transform-origin:96px 54px"><circle cx="96" cy="54" r="11" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M96 45v18M87 54h18" stroke="currentColor" stroke-width="2"/></g>' +
  '<path d="M34 54l14-14h24l10-14M72 40l24 14M60 40l-4 14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<circle cx="58" cy="14" r="7" fill="currentColor"/><path d="M58 22l-6 14h14" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="30" y="22" width="20" height="18" rx="3" fill="#f6b400" stroke="currentColor" stroke-width="3"/></g></svg>';
let delivT = null;
function delivNotice(o) {
  ensureAudio(); beep([523, 659, 784, 1047]);
  let d = document.getElementById('wzDel');
  if (!d) {
    const st = document.createElement('style');
    st.textContent = '#wzDel{position:fixed;left:12px;right:12px;top:12px;z-index:70;background:#fff;color:#16202a;border:3px solid #1f9d55;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:12px 14px;display:flex;align-items:center;gap:12px;transform:translateY(-140%);transition:transform .45s cubic-bezier(.2,1.2,.3,1)}#wzDel.on{transform:none}#wzDel .dv-ic{color:#16202a;flex:none}#wzDel b{display:block;font-size:19px;color:#1f9d55}#wzDel span{font-size:15px;line-height:1.3}#wzDel a{display:inline-block;margin-top:4px;font-weight:700;color:#16202a}.dv-bike{animation:dvr 1.1s ease-in-out infinite alternate}.dv-wheel{animation:dvw .6s linear infinite}@keyframes dvr{from{transform:translateX(-3px)}to{transform:translateX(4px)}}@keyframes dvw{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.dv-bike,.dv-wheel{animation:none}}';
    document.head.appendChild(st);
    d = document.createElement('div'); d.id = 'wzDel'; d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite');
    document.body.appendChild(d);
    d.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-dvh]')) { e.preventDefault(); S.tab = 'historial'; d.classList.remove('on'); render(); } });
  }
  d.innerHTML = '<div class="dv-ic">' + DELIV_SVG + '</div><div><b>¡Pedido entregado con éxito!</b><span>Tu servicio ' + esc(folio(o.id)) + ' ha sido entregado con éxito. Gracias por usar Gasca.</span><br><a href="#" data-dvh="1">Ver historial</a></div>';
  requestAnimationFrame(() => d.classList.add('on'));
  clearTimeout(delivT); delivT = setTimeout(() => {
    d.classList.remove('on');
    // solicitud personal: al cerrarse el aviso regresa solo al menú principal (nuevo pedido)
    try { if (view() === 'shop' && isCli(S.profile)) { S.tab = 'nuevo'; render(); window.scrollTo(0, 0); } } catch (e) {}
  }, 4500);
  try { buzz(); } catch (e) {}
}

/* ---------- pantalla "Crear cuenta": elegir quién eres, más llamativa ---------- */
(function () {
  const fs = document.getElementById('authRoles'); if (!fs) return;
  const ICON = { shop: '🏪', rider: '🛵', cliente: '📦' };
  const COLOR = { shop: '#f6b400', rider: '#1f9d55', cliente: '#2b7de9' };
  const LEDE = { shop: 'Perfecto. Registra tu negocio para pedir motos.', rider: 'Genial. Vamos a registrarte como repartidor.', cliente: 'Listo. Vamos a crear tu cuenta para enviar.' };
  const st = document.createElement('style');
  st.textContent = '#authRoles{grid-template-columns:1fr!important;gap:12px!important}#authRoles .role{display:block}#authRoles .card-r b{color:#16202a}#adminHome .ah-c b{color:#16202a}#adminHome .ah-c small{color:#4a5766}#adminBack button{color:#16202a}#authRoles .card-r{display:flex!important;flex-direction:column;justify-content:center;position:relative;padding:18px 18px 18px 84px!important;min-height:88px;border-radius:20px!important;border:2px solid var(--line,#d5dbe3)!important;background:#fff;box-shadow:0 3px 10px rgba(20,30,45,.08);transition:transform .15s,box-shadow .15s}' +
    '#authRoles .card-r:active{transform:scale(.98)}#authRoles .card-r b{font-size:21px}#authRoles .card-r small{font-size:15px}' +
    '#authRoles .rl-ic{position:absolute;left:16px;top:50%;transform:translateY(-50%);width:54px;height:54px;border-radius:16px;display:grid;place-items:center;font-size:30px}' +
    '#authRoles input:checked+.card-r{border-color:var(--rc,#f6b400)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--rc,#f6b400) 30%,transparent)}' +
    '#authRoles .rl-gone{display:none!important}#authRoles .role{animation:rlin .35s ease both}#authRoles .role:nth-of-type(2){animation-delay:.07s}#authRoles .role:nth-of-type(3){animation-delay:.14s}@keyframes rlin{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}' +
    '#rlChange{display:none;margin:0 0 4px;text-align:left;background:#fff;border:2px solid var(--line,#cfd6de);border-radius:14px;font-weight:800;font-size:16px;padding:10px 18px;min-height:46px;color:#16202a;box-shadow:0 2px 6px rgba(20,30,45,.08)}#rlChange:active{transform:scale(.97)}.rl-chosen #rlChange{display:inline-flex;align-items:center;gap:8px;width:auto;align-self:flex-start;justify-self:start}.rl-chosen .legend{display:none}' +
    '.rl-pick #fName,.rl-pick #fAddr,.rl-pick #fTel,.rl-pick #fEmail,.rl-pick #fPass,.rl-pick #fPass2,.rl-pick #authHint,.rl-pick #authBtn{display:none!important}' +
    '#authForm.rl-pick #rlWait{display:block}#rlWait{display:none;text-align:center;font-weight:700;opacity:.65;margin:6px 0}@media (prefers-reduced-motion:reduce){#authRoles .role{animation:none}}';
  document.head.appendChild(st);
  fs.insertAdjacentHTML('beforeend', '<button type="button" id="rlChange"><span aria-hidden="true">←</span> Regresar</button>');
  fs.insertAdjacentHTML('afterend', '<p id="rlWait">👆 Toca una opción para continuar</p>');
  fs.querySelectorAll('label.role').forEach((l) => {
    const v = l.querySelector('input').value, c = COLOR[v] || '#f6b400', card = l.querySelector('.card-r');
    card.style.setProperty('--rc', c); l.style.setProperty('--rc', c);
    if (!card.querySelector('.rl-ic')) card.insertAdjacentHTML('afterbegin', '<span class="rl-ic" style="background:color-mix(in srgb,' + c + ' 22%,#fff)" aria-hidden="true">' + (ICON[v] || '🛵') + '</span>');
  });
  let lastMode = '';
  function sync() {
    const mode = S.authMode, on = mode === 'signup' || mode === 'profile';
    const v = roleVal();
    af.classList.toggle('rl-pick', on && !v);
    fs.classList.toggle('rl-chosen', on && !!v);
    fs.querySelectorAll('label.role').forEach((l) => l.classList.toggle('rl-gone', on && !!v));
    if (on && !window.__aliasProf) { const lede = $('#authLede'); lede.textContent = v ? LEDE[v] : 'Elige cómo quieres usar Gasca. Solo toma un minuto.'; }
  }
  document.getElementById('rlChange').addEventListener('click', () => {
    [...af.querySelectorAll('input[name=role]')].forEach((r) => { r.checked = false; });
    setMode(S.authMode); sync();
  });
  af.addEventListener('change', () => setTimeout(sync, 0));
  setInterval(sync, 300);
})();

/* ---------- enlace/QR de soporte: ?soporte=correo ---------- */
(function () {
  let em = ''; try { em = (new URLSearchParams(location.search).get('soporte') || '').trim().toLowerCase(); } catch (e) {}
  if (!em || em.indexOf('@') < 0) return;
  S.soporteLink = true;
  const t = setInterval(() => {
    if (!S.ready) return; clearInterval(t);
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    if (S.user) return;
    const go = () => { if (window.__WC) window.__WC.on = false; if (window.__LN) window.__LN.on = false; setMode('owner'); $('#a-email').readOnly = false; $('#a-email').value = em; $('#a-email').readOnly = true; try { window.scrollTo(0, 0); } catch (e) {} };
    go(); setTimeout(go, 400);
  }, 100);
})();

/* ---------- pantalla de bienvenida (primera pantalla) ---------- */
(function () {
  const va = document.getElementById('viewAuth'); if (!va) return;
  const WC = { on: false }; window.__WC = WC;
  const LN = { on: true }; window.__LN = LN;
  const off = () => lsGet('gasca_nowelcome') === '1';
  const cards = [['shop', '🏪', 'Para negocios', 'Soy tienda o restaurante', '#f6b400'], ['rider', '🛵', 'Repartidor', 'Cuido tu pedido y entrego en tiempo y forma', '#1f9d55'], ['cliente', '📦', 'Para envíos personales', 'Quiero enviar algo', '#2b7de9']];
  const st = document.createElement('style');
  st.textContent = '#wcBox{display:none}.wc-on #wcBox{display:block}.wc-on #authTitle,.wc-on #authLede,.wc-on #authForm,.wc-on #authLinks,.wc-on #installHint{display:none!important}' +
    '.wc-hero{background:linear-gradient(135deg,#f6b400,#ffd24d);border-radius:24px;padding:18px 18px 22px;text-align:center;color:#16202a;overflow:hidden;box-shadow:0 8px 22px rgba(246,180,0,.35);animation:wcin .5s ease both}.wc-hero h2{margin:6px 0 2px;font-size:30px;line-height:1.1}.wc-hero p{margin:0;font-weight:600;opacity:.8}' +
    '.wc-road{position:relative;height:64px;margin:0 -18px 6px;overflow:hidden}.wc-road:after{content:"";position:absolute;left:0;right:0;bottom:6px;border-bottom:3px dashed rgba(22,32,42,.35)}.wc-ride{position:absolute;bottom:10px;left:0;animation:wcr 6s linear infinite}.wc-ride .dv-bike{animation:wcb 1s ease-in-out infinite alternate}.wc-ride .dv-wheel{animation:wcw .5s linear infinite}' +
    '@keyframes wcr{from{transform:translateX(-110px)}to{transform:translateX(420px)}}@keyframes wcb{from{transform:translateY(0)}to{transform:translateY(-2px)}}@keyframes wcw{to{transform:rotate(360deg)}}@keyframes wcin{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}' +
    '.wc-q{margin:22px 0 10px;font-size:22px}.wc-card{display:flex;align-items:center;gap:14px;width:100%;text-align:left;background:#fff;border:2px solid var(--line,#d5dbe3);border-radius:20px;padding:14px 16px;margin-bottom:12px;box-shadow:0 3px 10px rgba(20,30,45,.08);font:inherit;color:#16202a;animation:wcin .45s ease both;transition:transform .12s}.wc-card:active{transform:scale(.98)}.wc-card:nth-of-type(2){animation-delay:.08s}.wc-card:nth-of-type(3){animation-delay:.16s}' +
    '.wc-ic{flex:none;width:56px;height:56px;border-radius:16px;display:grid;place-items:center;font-size:30px}.wc-card b{display:block;font-size:21px}.wc-card small{font-size:15px;opacity:.7}.wc-card i{margin-left:auto;font-style:normal;font-size:26px;opacity:.4}' +
    '.wc-login{margin-top:6px;min-height:56px;font-size:18px;font-weight:800;background:#16202a!important;color:#ffc61a!important;border:0!important;border-radius:18px;box-shadow:0 6px 16px rgba(22,32,42,.35)}.wc-login:active{transform:scale(.98)}.wc-admin{display:block;margin:18px auto 4px;background:none;border:0;font-size:15px;font-weight:700;opacity:.6;padding:8px 14px;text-decoration:underline;color:inherit}#wcBack{display:none;margin:6px auto;background:none;border:0;font-weight:700;font-size:16px;text-decoration:underline;padding:8px;color:inherit}.wc-back #wcBack{display:block}@media (prefers-reduced-motion:reduce){.wc-ride,.wc-ride .dv-bike,.wc-ride .dv-wheel,.wc-hero,.wc-card{animation:none}}';
  document.head.appendChild(st);
  const box = document.createElement('div'); box.id = 'wcBox';
  box.innerHTML = '<div class="wc-hero"><div class="wc-road"><div class="wc-ride">' + DELIV_SVG + '</div></div><h2>¡Bienvenido a Gasca!</h2><p>Entregas certificadas</p></div>' +
    '<h3 class="wc-q">¿Cómo quieres usar Gasca?</h3>' +
    cards.map((c) => '<button type="button" class="wc-card" data-wc="' + c[0] + '"><span class="wc-ic" style="background:color-mix(in srgb,' + c[4] + ' 22%,#fff)" aria-hidden="true">' + c[1] + '</span><span><b>' + c[2] + '</b><small>' + c[3] + '</small></span><i aria-hidden="true">›</i></button>').join('') +
    '<button type="button" class="btn ghost block wc-login" data-wc="login">Ya tengo cuenta · Entrar</button>';
  document.getElementById('authLede').after(box);
  const back = document.createElement('button'); back.type = 'button'; back.id = 'wcBack'; back.textContent = '← Volver al inicio';
  document.getElementById('authLinks').after(back);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wc]'); if (!b) return;
    const v = b.getAttribute('data-wc'); WC.on = false;
    if (v === 'login') LN.on = true;
    if (v === 'login' || v === 'owner') setMode(v);
    else { setMode('signup'); const r = af.querySelector('input[name=role][value=' + v + ']'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }
    sync(); try { window.scrollTo(0, 0); } catch (er) {}
  });
  const mark = document.querySelector('.top .mark');
  let mkN = 0, mkT = 0;
  if (mark) mark.addEventListener('click', () => {
    if (view() !== 'auth' || S.user) return;
    const now = Date.now(); mkN = (now - mkT < 1500) ? mkN + 1 : 1; mkT = now;
    if (mkN < 3) return; mkN = 0;
    WC.on = false; LN.on = false; setMode('owner'); sync(); try { window.scrollTo(0, 0); } catch (er) {}
  });
  back.addEventListener('click', () => { WC.on = true; LN.on = false; setMode('login'); sync(); try { window.scrollTo(0, 0); } catch (er) {} });
  let hadUser = false;
  function sync() {
    const u = !!S.user;
    if (hadUser && !u && !off()) { LN.on = true; WC.on = false; if (S.authMode !== 'login') setMode('login'); }
    hadUser = u;
    const isAuth = view() === 'auth' && S.authMode === 'login' || (view() === 'auth' && WC.on);
    const show = !off() && WC.on && !LN.on && view() === 'auth' && S.authMode === 'login';
    if (show && !va.classList.contains('wc-on')) { try { window.scrollTo(0, 0); document.scrollingElement.scrollTop = 0; } catch (er) {} }
    va.classList.toggle('wc-on', show);
    va.classList.toggle('wc-back', !off() && !WC.on && !LN.on && view() === 'auth' && S.authMode !== 'profile');
  }
  // pantalla "Entrar" más amigable (solo cuando existe la bienvenida)
  const lst = document.createElement('style');
  lst.textContent = '#lgHero{display:none}.lg-on #lgHero{display:block}.lg-hero{background:linear-gradient(135deg,#f6b400,#ffd24d);border-radius:22px;overflow:hidden;color:#16202a;box-shadow:0 6px 18px rgba(246,180,0,.3);animation:wcin .45s ease both}.lg-hero .wc-road{margin:0;height:62px}' +
    '.lg-on #authLinks [data-act=mode-signup],.lg-on #authLinks [data-act=mode-owner]{display:none!important}.lg-on #authLinks{display:flex!important;flex-direction:column;gap:10px;margin-top:6px}.lg-on #authLinks button{display:block;width:100%;text-align:center;text-decoration:none;font-weight:700;font-size:17px;min-height:50px;border:2px solid var(--line,#cfd6de);border-radius:16px;background:#fff;color:inherit!important}' +
    '.lg-on #wcBack{display:block;width:100%;text-decoration:none;font-weight:700;font-size:17px;min-height:50px;border:2px solid var(--line,#cfd6de);border-radius:16px;background:#fff;margin:10px 0 0}.lg-on #authForm .field input{min-height:54px;font-size:17px}.lg-on #authBtn{min-height:56px;font-size:18px;font-weight:800}';
  document.head.appendChild(lst);
  const hero = document.createElement('div'); hero.id = 'lgHero';
  hero.innerHTML = '<div class="lg-hero"><div class="wc-road"><div class="wc-ride">' + DELIV_SVG + '</div></div></div>';
  document.getElementById('authTitle').before(hero);
  function lgSync() {
    const on = !off() && !WC.on && !LN.on && view() === 'auth' && S.authMode === 'login';
    va.classList.toggle('lg-on', on);
    if (on) { $('#authTitle').textContent = '¡Hola de nuevo!'; $('#authLede').textContent = 'Entra con tu correo o tu teléfono y tu contraseña.'; $('#a-pass').placeholder = 'Tu contraseña'; }
  }
  setInterval(lgSync, 250);
  setInterval(sync, 250);
})();

/* ---------- primera pantalla: Iniciar sesión (teléfono + contraseña) ---------- */
(function () {
  const va = document.getElementById('viewAuth'); if (!va || !window.__LN) return;
  const LN = window.__LN, WC = window.__WC;
  const off = () => lsGet('gasca_nowelcome') === '1';
  const COUNTRIES = 'MX|México|52;US|Estados Unidos|1;CA|Canadá|1;GT|Guatemala|502;BZ|Belice|501;SV|El Salvador|503;HN|Honduras|504;NI|Nicaragua|505;CR|Costa Rica|506;PA|Panamá|507;CU|Cuba|53;DO|República Dominicana|1;PR|Puerto Rico|1;CO|Colombia|57;VE|Venezuela|58;EC|Ecuador|593;PE|Perú|51;BO|Bolivia|591;CL|Chile|56;AR|Argentina|54;UY|Uruguay|598;PY|Paraguay|595;BR|Brasil|55;ES|España|34;PT|Portugal|351;FR|Francia|33;IT|Italia|39;DE|Alemania|49;GB|Reino Unido|44;IE|Irlanda|353;NL|Países Bajos|31;BE|Bélgica|32;CH|Suiza|41;AT|Austria|43;SE|Suecia|46;NO|Noruega|47;DK|Dinamarca|45;FI|Finlandia|358;PL|Polonia|48;RO|Rumania|40;UA|Ucrania|380;RU|Rusia|7;TR|Turquía|90;GR|Grecia|30;IL|Israel|972;AE|Emiratos Árabes|971;SA|Arabia Saudita|966;EG|Egipto|20;MA|Marruecos|212;ZA|Sudáfrica|27;NG|Nigeria|234;KE|Kenia|254;IN|India|91;PK|Pakistán|92;CN|China|86;JP|Japón|81;KR|Corea del Sur|82;PH|Filipinas|63;VN|Vietnam|84;TH|Tailandia|66;ID|Indonesia|62;MY|Malasia|60;SG|Singapur|65;AU|Australia|61;NZ|Nueva Zelanda|64'.split(';').map((x) => { const a = x.split('|'); return { iso: a[0], name: a[1], dial: a[2] }; });
  const flag = (iso) => String.fromCodePoint(...iso.split('').map((c) => 127397 + c.charCodeAt(0)));
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let cc = COUNTRIES[0], mailMode = false;
  const st = document.createElement('style');
  st.textContent = '#lnBox{display:none}.ln-on #lnBox{display:block}.ln-on #authTitle,.ln-on #authLede,.ln-on #authForm,.ln-on #authLinks,.ln-on #installHint,.ln-on #wcBack,.ln-on #wcBox{display:none!important}body.ln-body .top{display:none}body.ln-body,body:has(#viewAuth.wc-on){background:#f2f4f7!important;color:#16202a}body:has(#viewAuth.wc-on) .top{background:#f2f4f7!important;border-color:transparent!important}body:has(#viewAuth.wc-on) .brandname{color:#16202a!important}body:has(#viewAuth.wc-on) .tagline{color:#5b6672!important}' +
    '#lnBox{padding:22px 0 30px;animation:wcin .4s ease both}.ln-logo{text-align:center;margin:8px 0 26px;user-select:none;-webkit-user-select:none}.ln-mark{width:92px;height:92px;margin:0 auto;border-radius:28px;background:#f6b400;display:grid;place-items:center;color:#16202a;box-shadow:0 8px 22px rgba(246,180,0,.4)}.ln-mark svg{width:56px;height:56px}.ln-name{margin-top:10px;font-family:"Barlow Condensed",system-ui,sans-serif;font-weight:700;font-size:20px;letter-spacing:4px;text-transform:uppercase;color:#16202a}' +
    '.ln-title{font-size:34px;font-weight:800;color:#0d141b;margin:0 0 18px;font-family:"Barlow Condensed",system-ui,sans-serif}' +
    '.ln-field{position:relative;display:flex;align-items:center;background:#fff;border:2px solid var(--line,#d5dbe3);border-radius:16px;min-height:58px;margin-bottom:14px}.ln-field:focus-within{border-color:#16202a}.ln-field input{flex:1;min-width:0;border:0;background:none;font:inherit;font-size:18px;padding:14px 12px;color:#16202a;outline:none}.ln-field input::placeholder{color:#c3c9d1}' +
    '.ln-cc{flex:none;display:flex;align-items:center;gap:6px;border:0;background:none;font:inherit;font-size:17px;font-weight:700;padding:0 4px 0 14px;height:54px;color:#16202a;border-right:2px solid var(--line,#e3e7ec)}.ln-cc i{font-style:normal;font-size:12px;opacity:.6}' +
    '.ln-lock{flex:none;margin-left:14px;color:#c3c9d1;display:grid}.ln-lock svg{width:22px;height:22px}.ln-field .pw-eye{position:static;transform:none;margin-right:4px;flex:none}' +
    '.ln-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:2px 0 18px}.ln-rem{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:#16202a}.ln-rem input{width:22px;height:22px;accent-color:#16202a}.ln-link{background:none;border:0;font:inherit;color:#16202a;cursor:pointer;padding:6px 0}.ln-row .ln-link{font-size:14px;font-weight:600}.ln-link.u{text-decoration:underline;font-weight:800}' +
    '.ln-reg{text-align:center;margin:18px 0 6px;font-size:16px;color:#16202a}.ln-alt{display:block;margin:10px auto 0;font:inherit;font-size:14px;color:#6b7683;text-decoration:underline;background:none;border:0;padding:8px 12px}' +
    '#lnCcSheet{position:fixed;inset:0;z-index:9999;background:rgba(10,15,20,.55);display:flex;align-items:flex-end}#lnCcSheet .sh{background:#fff;width:100%;max-height:82vh;border-radius:22px 22px 0 0;display:flex;flex-direction:column;padding:16px 16px 10px}#lnCcSheet h3{margin:0 0 10px;font-size:20px}#lnCcSheet input{font:inherit;font-size:17px;border:2px solid var(--line,#d5dbe3);border-radius:14px;padding:12px;margin-bottom:8px}#lnCcSheet .ls{overflow:auto;flex:1}#lnCcSheet .it{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid #eef0f3;font:inherit;font-size:17px;padding:13px 4px;color:#16202a}#lnCcSheet .it b{margin-left:auto}';
  document.head.appendChild(st);
  const box = document.createElement('div'); box.id = 'lnBox';
  const MARK = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="23" r="4"/><circle cx="25" cy="23" r="4"/><path d="M8 23l5-9h6l3 9M19 14l-2-5h4M13 14H9"/></svg>';
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  box.innerHTML = '<div class="ln-logo" id="lnLogo"><div class="ln-mark">' + MARK + '</div><div class="ln-name">Gasca</div></div>' +
    '<h1 class="ln-title">Iniciar sesión</h1>' +
    '<form id="lnForm" novalidate>' +
    '<div class="ln-field" id="lnTelRow"><button type="button" class="ln-cc" id="lnCc"><span id="lnFlag"></span><span id="lnDial"></span><i>▼</i></button><input id="ln-tel" name="username" type="tel" inputmode="numeric" autocomplete="username" maxlength="16" placeholder="Número de teléfono"></div>' +
    '<div class="ln-field" id="lnMailRow" hidden><input id="ln-mail" name="username" type="email" autocomplete="username" maxlength="80" placeholder="Correo electrónico" style="padding-left:16px"></div>' +
    '<div class="ln-field"><span class="ln-lock">' + LOCK + '</span><input id="ln-pass" name="password" type="password" autocomplete="current-password" maxlength="100" placeholder="Contraseña"><button type="button" class="pw-eye" id="lnEye" aria-label="Mostrar contraseña">' + EYE + '</button></div>' +
    '<p class="warn" id="lnErr" role="alert" hidden></p>' +
    '<div class="ln-row"><label class="ln-rem"><input type="checkbox" id="ln-rem" checked> Recordarme</label><button type="button" class="ln-link" id="lnForgot">¿Olvidaste tu contraseña?</button></div>' +
    '<button class="btn primary block" type="submit" id="lnGo">Iniciar sesión</button></form>' +
    '<p class="ln-reg">¿Aún no tienes cuenta? <button type="button" class="ln-link u" id="lnReg">Registrarme</button></p>' +
    '<button type="button" class="ln-alt" id="lnAlt">Entrar con correo</button>';
  document.getElementById('authTitle').before(box);
  const $l = (id) => document.getElementById(id);
  function paintCc() { $l('lnFlag').textContent = flag(cc.iso); $l('lnDial').textContent = '+' + cc.dial; }
  paintCc();
  setTimeout(() => { try { const t = lsGet('gasca_ln_tel'); if (t) { const a = t.split('|'); const c = COUNTRIES.find((x) => x.iso === a[0]); if (c) { cc = c; paintCc(); } $l('ln-tel').value = a[1] || ''; $l('ln-rem').checked = true; } } catch (e) {} }, 0);
  $l('lnEye').addEventListener('click', () => { const inp = $l('ln-pass'), show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; $l('lnEye').innerHTML = show ? OFF : EYE; $l('lnEye').setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña'); });
  $l('lnCc').addEventListener('click', () => {
    const sh = document.createElement('div'); sh.id = 'lnCcSheet';
    sh.innerHTML = '<div class="sh"><h3>Código de país</h3><input id="lnCcQ" type="search" placeholder="Buscar país o código" autocomplete="off"><div class="ls" id="lnCcL"></div><button type="button" class="btn ghost block" id="lnCcX" style="margin-top:8px">Cerrar</button></div>';
    document.body.appendChild(sh);
    const draw = () => { const q = norm($l('lnCcQ').value).replace(/^\+/, ''); $l('lnCcL').innerHTML = COUNTRIES.filter((c) => !q || norm(c.name).indexOf(q) >= 0 || c.dial.indexOf(q) === 0).map((c) => '<button type="button" class="it" data-iso="' + c.iso + '"><span>' + flag(c.iso) + '</span><span>' + esc(c.name) + '</span><b>+' + c.dial + '</b></button>').join('') || '<p class="hint">No hay resultados.</p>'; };
    draw(); $l('lnCcQ').addEventListener('input', draw);
    sh.addEventListener('click', (e) => { const it = e.target.closest('.it'); if (it) { cc = COUNTRIES.find((c) => c.iso === it.getAttribute('data-iso')) || cc; paintCc(); sh.remove(); } else if (e.target === sh || e.target.id === 'lnCcX') sh.remove(); });
    setTimeout(() => { try { $l('lnCcQ').focus(); } catch (e) {} }, 50);
  });
  $l('lnAlt').addEventListener('click', () => { mailMode = !mailMode; $l('lnTelRow').hidden = mailMode; $l('lnMailRow').hidden = !mailMode; $l('lnAlt').textContent = mailMode ? 'Entrar con teléfono' : 'Entrar con correo'; S.authErr = ''; });
  $l('lnReg').addEventListener('click', () => { LN.on = false; WC.on = true; S.authErr = ''; setMode('login'); try { window.scrollTo(0, 0); } catch (e) {} });
  const ident = () => mailMode ? $l('ln-mail').value.trim().toLowerCase() : $l('ln-tel').value.replace(/\D/g, '').slice(-10);
  $l('lnForgot').addEventListener('click', () => { const id = ident(); $('#a-email').value = id; if (!mailMode && id.length < 10) { S.authErr = 'Escribe tu teléfono arriba y vuelve a tocar "¿Olvidaste tu contraseña?".'; return; } resetPass(); });
  $l('lnForm').addEventListener('submit', async (e) => {
    e.preventDefault(); if (S.authBusy) return;
    const id = ident(), pw = $l('ln-pass').value, rem = $l('ln-rem').checked;
    if (!mailMode && id.length < 10) { S.authErr = 'Escribe tu número de teléfono de 10 dígitos.'; return; }
    if (mailMode && id.indexOf('@') < 1) { S.authErr = 'Escribe tu correo.'; return; }
    if (!pw) { S.authErr = 'Escribe tu contraseña.'; return; }
    try { if (rem) lsSet('gasca_ln_tel', mailMode ? '' : cc.iso + '|' + id); else { localStorage.removeItem('gasca_ln_tel'); } } catch (er) {}
    try { await setPersistence(auth, rem ? browserLocalPersistence : browserSessionPersistence); } catch (er) {}
    S.authErr = ''; setMode('login');
    $('#a-email').value = id; $('#a-pass').value = pw;
    af.requestSubmit ? af.requestSubmit() : af.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  let mkN = 0, mkT = 0;
  $l('lnLogo').addEventListener('click', () => {
    const now = Date.now(); mkN = (now - mkT < 1500) ? mkN + 1 : 1; mkT = now;
    if (mkN < 3) return; mkN = 0;
    LN.on = false; WC.on = false; setMode('owner'); try { window.scrollTo(0, 0); } catch (er) {}
  });
  function lnSync() {
    const show = !off() && LN.on && view() === 'auth' && S.authMode === 'login';
    va.classList.toggle('ln-on', show); document.body.classList.toggle('ln-body', show);
    if (!show) return;
    const er = $l('lnErr'), t = S.authErr || '';
    if (er.textContent !== t) { er.textContent = t; er.hidden = !t; }
    $l('lnGo').disabled = !!S.authBusy;
  }
  setInterval(lnSync, 200);
})();


/* ---------- zonas de trabajo (por colonia) ---------- */
const nrm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function zoneOf(o) {
  const z = S.zonas || [], txt = nrm((o && o.pickup) || '');
  let best = null, len = 0;
  z.forEach((zn) => (zn.colonias || []).forEach((c) => { const k = nrm(c); if (k && k.length > len && txt.indexOf(k) >= 0) { best = zn; len = k.length; } }));
  return best;
}
const zonesKey = () => 'gasca_zonas_' + S.uid;
function myZones() { try { const a = JSON.parse(lsGet(zonesKey()) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
const modoKey = () => 'gasca_modo_' + S.uid;
function rMode() { return 'cerca'; }
function geoCached(txt) { const c = geoLoad(), k = nrm(txt); if (k in c) return c[k]; if (GEO.fail.has(k)) return null; return undefined; }
function nearOk(o) {
  if (!S.pos) return true; /* sin GPS aún: mejor mostrar el pedido que esconderlo */
  const pt = geoCached(o.pickup);
  if (pt === undefined) {
    const k = nrm(o.pickup);
    if (!GEO.pp.has(k)) { GEO.pp.add(k); geoPoint(o.pickup).then(() => { GEO.pp.delete(k); refilter(); }); }
    return false;
  }
  if (!pt) return true;
  return hav([S.pos.lat, S.pos.lon], pt) <= (S.radioKm || 3);
}
function refilter() {
  if (S.role !== 'rider') return;
  mergeOrders();
  S.queue = S.queue.filter((qid) => { const o = byId(qid); return o && inMyZone(o); });
  if (S.online) queueOpen();
  syncSheet(); render();
}
function inMyZone(o) {
  const mode = rMode();
  if (mode === 'todos') return true;
  if (mode === 'cerca') return nearOk(o);
  if (!S.zonas || !S.zonas.length) return true;
  const mine = myZones().filter((id) => S.zonas.some((z) => z.id === id));
  if (!mine.length) return true;
  const z = zoneOf(o);
  return !z || mine.indexOf(z.id) >= 0;
}
function zoneTag(o) { const z = zoneOf(o); return z ? '<br><small>📍 ' + esc(z.nombre) + '</small>' : ''; }

/* barra "Mi zona" del repartidor */
(function () {
  const st = document.createElement('style');
  st.textContent = '#zoneBar{margin:10px 0 4px}#zoneBar .zl{display:block;font-weight:800;margin:0 0 6px}#zoneBar .zc{display:flex;flex-wrap:wrap;gap:8px}#zoneBar button{border:2px solid var(--line,#cfd6de);background:#fff;border-radius:99px;padding:8px 14px;font-weight:700;min-height:42px;font:inherit;font-weight:700;color:inherit}#zoneBar button.on{background:#f6b400;border-color:#f6b400;color:#16202a}' +
    '#zonasEd .zn{background:#fff;border:2px solid var(--line,#d5dbe3);border-radius:16px;padding:12px;margin-bottom:12px}#zonasEd textarea{min-height:90px}#zonasEd .btn{margin-top:6px}#zonasEd .zs{font-size:14px;opacity:.75;margin:4px 0}';
  document.head.appendChild(st);
  let sig = '';
  function bar() {
    let el = document.getElementById('zoneBar');
    const head = document.getElementById('riderHead');
    const show = head && view() === 'rider' && S.tab === 'disp' && rMode() === 'zonas' && S.zonas && S.zonas.length;
    if (!el && head) { el = document.createElement('div'); el.id = 'zoneBar'; head.after(el); }
    if (!el) return;
    el.hidden = !show; if (!show) return;
    const mine = myZones().filter((id) => S.zonas.some((z) => z.id === id));
    const s2 = mine.join(',') + '|' + S.zonas.map((z) => z.id + z.nombre).join(',');
    if (s2 === sig && el.innerHTML) return; sig = s2;
    el.innerHTML = '<span class="zl">📍 ¿Dónde trabajas hoy?</span><div class="zc"><button type="button" data-zone="*" class="' + (mine.length ? '' : 'on') + '">Todas</button>' +
      S.zonas.map((z) => '<button type="button" data-zone="' + esc(z.id) + '" class="' + (mine.indexOf(z.id) >= 0 ? 'on' : '') + '">' + esc(z.nombre) + '</button>').join('') + '</div>';
  }
  setInterval(bar, 400);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-zone]'); if (!b) return;
    const id = b.getAttribute('data-zone');
    let mine = myZones().filter((x) => S.zonas.some((z) => z.id === x));
    if (id === '*') mine = []; else if (mine.indexOf(id) >= 0) mine = mine.filter((x) => x !== id); else mine.push(id);
    lsSet(zonesKey(), JSON.stringify(mine)); sig = '';
    mergeOrders(); S.queue = S.queue.filter((qid) => { const o = byId(qid); return o && inMyZone(o); }); syncSheet(); render(); bar();
  });
})();

/* editor de zonas del dueño (en Ajustes) */
(function () {
  const host = document.getElementById('adminAjustes'); if (!host) return;
  const ed = document.createElement('div'); ed.id = 'zonasEd'; ed.className = 'stack'; ed.hidden = true;
  host.after(ed);
  let draft = null, dirty = false, lastSrc = '', radio = 3, tar = tarCfg();
  const src = () => JSON.stringify(S.zonas || []);
  function html() {
    const unk = []; (S.orders || []).forEach((o) => { if (o.pickup && !zoneOf(o) && unk.indexOf(o.pickup) < 0) unk.push(o.pickup); });
    return '<h2 class="section">Pedidos cercanos</h2><p class="hint">Los repartidores reciben solo los pedidos que están a este radio de donde se encuentran, usando el GPS de su celular (siempre encendido mientras están en línea).</p><div class="field"><label for="zn-radio">Radio (km)</label><input type="number" id="zn-radio" min="0.5" max="20" step="0.5" inputmode="decimal" value="' + radio + '"></div><h2 class="section" style="margin-top:18px">Tarifa por distancia (restaurantes)</h2><p class="hint">La app calcula los km entre el negocio y el cliente y sugiere esta tarifa. El negocio puede cambiarla.</p>' +
      [0, 1, 2].map((k) => '<div class="field"><label>Tramo ' + (k + 1) + '</label><div style="display:flex;gap:8px;align-items:center">hasta <input type="number" id="tr-h' + k + '" min="0.5" step="0.5" inputmode="decimal" value="' + esc(String(tar.tramos[k].hasta)) + '" style="width:90px"> km → $ <input type="number" id="tr-p' + k + '" min="1" step="1" inputmode="numeric" value="' + esc(String(tar.tramos[k].precio)) + '" style="width:90px"></div></div>').join('') +
      '<div class="field"><label>Después del último tramo, cada km extra</label><div style="display:flex;gap:8px;align-items:center">$ <input type="number" id="tr-x" min="0" step="1" inputmode="numeric" value="' + esc(String(tar.extra)) + '" style="width:90px"></div></div>' +
      '<button class="btn primary block" type="button" data-zact="save" style="margin-top:10px">Guardar</button>';
  }
  function sync() {
    if (view() !== 'admin' || S.tab !== 'zonas') { ed.hidden = true; return; }
    ed.hidden = false;
    if (!draft || (!dirty && lastSrc !== src())) { draft = JSON.parse(src()); lastSrc = src(); dirty = false; radio = S.radioKm || 3; tar = tarCfg(); if (!draft.length) draft = []; }
    if (ed.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const h = html(); if (ed.dataset.h !== h) { ed.innerHTML = h; ed.dataset.h = h; }
  }
  setInterval(sync, 400);
  ed.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'zn-radio') { radio = t.value; dirty = true; return; }
    { const m = /^tr-([hp])(\d)$/.exec(t.id || ''); if (m) { tar.tramos[Number(m[2])][m[1] === 'h' ? 'hasta' : 'precio'] = t.value; dirty = true; return; } if (t.id === 'tr-x') { tar.extra = t.value; dirty = true; return; } }
    const i = Number(t.getAttribute('data-zi')); if (!draft || isNaN(i) || !draft[i]) return;
    dirty = true;
    if (t.getAttribute('data-zf') === 'n') draft[i].nombre = t.value; else draft[i].colonias = t.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  });
  ed.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-zact]'); if (!b) return;
    const a = b.getAttribute('data-zact');
    if (a === 'add') { draft.push({ id: 'z' + Date.now().toString(36), nombre: '', colonias: [] }); dirty = true; ed.dataset.h = ''; sync(); }
    else if (a === 'del') { draft.splice(Number(b.getAttribute('data-zi')), 1); dirty = true; ed.dataset.h = ''; sync(); }
    else if (a === 'save') {
      const out = Array.isArray(S.zonas) ? S.zonas : [];
      const rk = Math.min(20, Math.max(0.5, Number(radio) || 3));
      const tr = tar.tramos.map((x) => ({ hasta: Number(x.hasta), precio: Math.round(Number(x.precio)) }));
      if (tr.some((x, k) => !(x.hasta > 0) || !(x.precio >= 1 && x.precio <= 2000) || (k && x.hasta <= tr[k - 1].hasta))) { toast('Revisa los tramos: los km deben ir subiendo y el precio ser de $1 a $2,000.'); return; }
      const ex = Math.max(0, Math.min(500, Math.round(Number(tar.extra) || 0)));
      try { await setDoc(doc(db, 'config', 'tarifas'), { tramos: tr, extra: ex, actualizado: Date.now() }); } catch (er) { toast('No se pudo guardar la tarifa.'); return; }
      try { await setDoc(doc(db, 'config', 'zonas'), { zonas: out, radioKm: rk, actualizado: Date.now() }); dirty = false; draft = null; lastSrc = ''; ed.dataset.h = ''; toast('Radio guardado.'); }
      catch (er) { toast('No se pudo guardar. Intenta de nuevo.'); }
    }
  });
})();

/* ---------- pantalla principal del dueño (menú con todas las secciones) ---------- */
(function () {
  const st = document.createElement('style');
  st.textContent = '#adminHome h2{margin-bottom:4px}#adminHome .ah-g{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}#adminHome .ah-c{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;background:#fff;border:2px solid var(--line,#d5dbe3);border-radius:20px;padding:16px 14px;min-height:118px;box-shadow:0 3px 10px rgba(20,30,45,.08);font:inherit;color:inherit}#adminHome .ah-c:active{transform:scale(.98)}#adminHome .ah-i{font-size:30px;line-height:1}#adminHome .ah-c b{font-size:19px}#adminHome .ah-c small{opacity:.7;font-size:14px;line-height:1.25}#adminHome .ah-b{position:absolute;top:10px;right:10px;background:#16202a;color:#ffc61a;border-radius:99px;min-width:26px;height:26px;padding:0 8px;display:grid;place-items:center;font-weight:800;font-size:14px}' +
    '#adminBack{display:none;margin:0 0 6px}#adminBack button{background:#fff;border:2px solid var(--line,#cfd6de);border-radius:14px;font:inherit;font-weight:800;padding:10px 16px;min-height:46px;color:#16202a}.ah-in #adminBack{display:block}';
  document.head.appendChild(st);
})();
const AH = { monitor: ['📡', 'En vivo', 'Pedidos y repartidores ahora'], altas: ['🧾', 'Altas', 'Aprobar o dar de baja'], recargas: ['💵', 'Recargas', 'Pagos de repartidores'], soporte: ['🎧', 'Soporte', 'Agentes y su trabajo'], pedidos: ['📦', 'Pedidos', 'Por atender, con éxito y no entregados'], incidencias: ['⚠️', 'Incidencias', 'Reportes y accidentes'], saldos: ['👛', 'Saldos', 'Lo que tiene cada repartidor'], zonas: ['📍', 'Radio', 'Distancia de pedidos cercanos'], ajustes: ['🏦', 'Depósito', 'Datos para recargar'] };
function adminHome(list) {
  const host = $('#adminMonitor'); if (!host) return;
  let el = document.getElementById('adminHome');
  if (!el) {
    el = document.createElement('div'); el.id = 'adminHome'; el.className = 'stack'; host.before(el);
    const bk = document.createElement('div'); bk.id = 'adminBack'; bk.innerHTML = '<button type="button" data-act="tab" data-tab="inicio">← Inicio</button>'; el.before(bk);
  }
  const home = S.tab === 'inicio';
  el.hidden = !home; $('#viewAdmin').classList.toggle('ah-in', !home);
  if (!home) return;
  const h = '<h2 class="section">Panel de administración</h2><p class="hint">Toca una sección para entrar.</p><div class="ah-g">' +
    (list || []).map((t) => { const a = AH[t.id] || ['•', t.label, '']; return '<button type="button" class="ah-c" data-act="tab" data-tab="' + t.id + '"><span class="ah-i">' + a[0] + '</span><b>' + esc(a[1]) + '</b><small>' + esc(a[2]) + '</small>' + (t.badge ? '<span class="ah-b">' + t.badge + '</span>' : '') + '</button>'; }).join('') + '</div>';
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}

/* ---------- cambiar de perfil estando dada de baja (misma cuenta) ---------- */
function renderSwitch(el) {
  if (document.activeElement && /^(sw-name|sw-addr|sw-tel)$/.test(document.activeElement.id || '')) return;
  const r = S.swrRole, card = (v, ic, t, sm) => '<button type="button" class="wc-card' + (r === v ? ' sel' : '') + '" data-act="swr-pick" data-r="' + v + '" style="' + (r === v ? 'border-color:#f6b400;box-shadow:0 0 0 3px rgba(246,180,0,.35)' : '') + '"><span class="wc-ic" style="background:#fff3cf" aria-hidden="true">' + ic + '</span><span><b>' + t + '</b><small>' + sm + '</small></span></button>';
  el.innerHTML = '<h1>Cambiar de perfil</h1><p class="lede">Sigues teniendo una sola cuenta, con tu mismo correo. Elige con qué perfil quieres entrar ahora.</p>' +
    card('shop', '🏪', 'Para negocios', 'Soy tienda o restaurante') + card('rider', '🛵', 'Repartidor', 'Cuido tu pedido y entrego en tiempo y forma') + card('cliente', '📦', 'Para envíos personales', 'Quiero enviar algo') +
    (r ? '<div class="field"><label for="sw-name">' + (r === 'shop' ? 'Nombre del negocio' : 'Tu nombre completo') + '</label><input id="sw-name" type="text" maxlength="60" value="' + esc(S.swrName) + '"></div>' : '') +
    (r === 'shop' ? '<div class="field"><label for="sw-addr">Dirección de recogida</label><input id="sw-addr" type="text" maxlength="160" placeholder="Calle, número y colonia" value="' + esc(S.swrAddr) + '"></div>' : '') +
    (r === 'cliente' ? '<div class="field"><label for="sw-tel">Tu teléfono (10 dígitos)</label><input id="sw-tel" type="tel" inputmode="numeric" maxlength="14" value="' + esc(S.swrTel) + '"></div>' : '') +
    '<p class="hint">Después te pediremos de nuevo tus documentos, y la administración los revisará.</p>' +
    '<div class="actions"><button class="btn ghost" type="button" data-act="swr-close">Cancelar</button><button class="btn primary" type="button" data-act="swr-go"' + (r && !S.busy.has('swr') ? '' : ' disabled') + '>Continuar</button></div>';
}
document.addEventListener('input', (e) => { const t = e.target; if (!t || !t.id) return; if (t.id === 'sw-name') S.swrName = t.value; else if (t.id === 'sw-addr') S.swrAddr = t.value; else if (t.id === 'sw-tel') S.swrTel = t.value; });
async function switchRole() {
  const r = S.swrRole, name = (S.swrName || '').trim();
  if (!r || !S.profile || S.busy.has('swr') || !canAct()) return;
  if (name.length < 2) { toast('Escribe tu nombre.'); return; }
  const base = { id: S.uid, role: r === 'rider' ? 'rider' : 'shop', name: name.slice(0, 60), creadoEn: S.profile.creadoEn || Date.now(), cambioEn: Date.now(), fotos: [] };
  if (r === 'shop') { const a = (S.swrAddr || '').trim(); if (a.length < 5) { toast('Escribe la dirección de recogida.'); return; } base.addr = a.slice(0, 160); }
  if (r === 'cliente') { const t = (S.swrTel || '').replace(/\D/g, ''); if (t.length !== 10) { toast('Escribe tu teléfono de 10 dígitos.'); return; } base.addr = 'CLIENTE · Tel ' + t; }
  S.busy.add('swr'); render();
  try {
    await setDoc(doc(db, 'users', S.uid), base);
    S.swr = false; S.tab = ''; S.verEdit = false; S.consent = false;
    toast('Listo. Ahora envía tus documentos.');
  } catch (e) { toast('No se pudo cambiar el perfil. Intenta de nuevo.'); }
  S.busy.delete('swr'); render();
}

/* ---------- distancia aproximada del pedido (OpenStreetMap) ---------- */
const GEO = { cache: null, q: [], busy: false, last: 0, pend: new Set(), fail: new Set(), pp: new Set() };
function geoLoad() { if (!GEO.cache) { try { GEO.cache = JSON.parse(lsGet('gasca_geo') || '{}') || {}; } catch (e) { GEO.cache = {}; } } return GEO.cache; }
function geoSave() { try { const k = Object.keys(GEO.cache); if (k.length > 300) k.slice(0, 100).forEach((x) => delete GEO.cache[x]); lsSet('gasca_geo', JSON.stringify(GEO.cache)); } catch (e) {} }
function geoQueries(txt) {
  const t = String(txt || '').replace(/\s*[—-]\s*Ref:.*$/i, '').replace(/\bInt\.?\s*\S+/ig, '').replace(/\bCol\.?\s+/ig, '').replace(/\s+/g, ' ').trim();
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean), tail = /nayarit/i.test(t) ? '' : ', Nayarit, México';
  const base = [parts.join(', ') + tail, parts.map((p) => p.replace(/\b\d+\w*\b/g, '').trim()).filter(Boolean).join(', ') + tail].filter((x, i, a) => x.length > 8 && a.indexOf(x) === i);
  const loose = [];
  if (parts.length > 2) { loose.push(parts.slice(1).join(', ') + tail); loose.push(parts.slice(-2).join(', ') + tail); }
  const res = base.concat(loose.filter((x, i) => x.length > 8 && base.indexOf(x) < 0 && loose.indexOf(x) === i));
  res.looseFrom = base.length; // de aquí en adelante ya no se usó la calle: el punto es solo de la zona
  return res;
}
function geoApprox(txt) { try { return !!geoLoad()[nrm(txt) + '~']; } catch (e) { return false; } }
async function geoFetch(q) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=mx&viewbox=-105.8,23.1,-103.7,20.6&bounded=0&accept-language=es&q=' + encodeURIComponent(q), { signal: ctl.signal });
    if (!r.ok) throw new Error('http');
    const j = await r.json();
    return j && j[0] ? [Number(j[0].lat), Number(j[0].lon)] : null;
  } finally { clearTimeout(tm); }
}
async function geoPump() {
  if (GEO.busy) return; GEO.busy = true;
  while (GEO.q.length) {
    const it = GEO.q.shift(), c = geoLoad();
    if (it.key in c) { it.res(c[it.key]); continue; }
    let pt = null, failed = false;
    let qi = 0;
    for (const q of it.qs) {
      const wait = GEO.last + 1150 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { GEO.last = Date.now(); pt = await geoFetch(q); } catch (e) { failed = true; break; }
      if (pt) break;
      qi++;
    }
    if (!failed) { c[it.key] = pt || 0; if (pt && it.qs.looseFrom != null && qi >= it.qs.looseFrom) c[it.key + '~'] = 1; geoSave(); }
    if (failed) GEO.fail.add(it.key);
    it.res(failed ? null : pt);
  }
  GEO.busy = false;
}
setInterval(() => { try { GEO.fail.clear(); } catch (e) {} }, 45000);
const geoPoint = (txt) => new Promise((res) => { const qs = geoQueries(txt), key = nrm(txt); if (!qs.length) { res(null); return; } GEO.q.push({ key, qs, res }); geoPump(); });
function hav(a, b) { const R = 6371, d = Math.PI / 180, dl = (b[0] - a[0]) * d, dn = (b[1] - a[1]) * d, x = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * d) * Math.cos(b[0] * d) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function distFor(o) {
  if (!o || !o.id) return null;
  S.dist = S.dist || {};
  const d = S.dist[o.id];
  if (d !== undefined) return d;
  if (GEO.pend.has(o.id)) return undefined;
  GEO.pend.add(o.id);
  Promise.all([geoPoint(o.pickup), geoPoint(o.dest)]).then(([a, b]) => {
    let km = null;
    if (a && b) { km = hav(a, b) * 1.3; if (km > 60) km = null; }
    S.dist[o.id] = km; GEO.pend.delete(o.id);
    if (S.sheetId === o.id) renderSheet(true);
    render();
  });
  return undefined;
}
function fmtKm(k) { return k < 1 ? Math.max(1, Math.round(k * 10)) * 100 + ' m' : (Math.round(k * 10) / 10).toString().replace('.0', '') + ' km'; }
function distLine(o) {
  const d = distFor(o);
  let near = '';
  if (S.pos) { const pt = geoCached(o.pickup); if (pt) near = '<div class="line"><span class="k">Estás a</span><span class="v"><b>' + fmtKm(hav([S.pos.lat, S.pos.lon], pt)) + '</b> de la recolección</span></div>'; }
  if (d === null) return near;
  const txt = d === undefined ? '<small>calculando…</small>' : '<b>≈ ' + fmtKm(d) + '</b> <small>aprox. · © OpenStreetMap</small>';
  return near + '<div class="line"><span class="k">Recorrido</span><span class="v">' + txt + '</span></div>';
}

/* ---------- tarifa sugerida por distancia (solo restaurantes) ---------- */
function TAR_DEF() { return { tramos: [{ hasta: 3, precio: 45 }, { hasta: 7, precio: 65 }, { hasta: 10, precio: 70 }], extra: 5 }; }
function tarCfg() {
  const c = S.tarifas, ok = c && Array.isArray(c.tramos) && c.tramos.length === 3 && c.tramos.every((x) => Number(x.hasta) > 0 && Number(x.precio) > 0);
  const b = ok ? c : TAR_DEF();
  return { tramos: b.tramos.map((x) => ({ hasta: Number(x.hasta), precio: Number(x.precio) })), extra: b.extra != null ? Number(b.extra) : 5 };
}
function tarFor(km) {
  const c = tarCfg(), t = c.tramos.find((x) => km <= x.hasta);
  if (t) return t.precio;
  const l = c.tramos[c.tramos.length - 1];
  return l.precio + Math.ceil(km - l.hasta) * c.extra;
}
(function () {
  const st = document.createElement('style');
  st.textContent = '#quoteBox{margin:8px 0 0;padding:10px 12px;border-radius:12px;background:#fff7e0;color:#16202a;border:2px solid #f6b400;font-size:14.5px;font-weight:600}#quoteBox small{display:block;font-weight:500;opacity:.75;margin-top:2px}#quoteBox button{margin-top:6px;border:2px solid #16202a;background:#fff;border-radius:99px;padding:6px 12px;font:inherit;font-weight:800;color:#16202a;min-height:38px}';
  document.head.appendChild(st);
  let key = '', timer = 0, auto = null, seq = 0;
  const box = () => {
    let b = document.getElementById('quoteBox');
    if (!b) { const f = document.getElementById('o-tarifa') && document.getElementById('o-tarifa').closest('.field'); if (!f) return null; b = document.createElement('div'); b.id = 'quoteBox'; b.hidden = true; f.appendChild(b); }
    return b;
  };
  const on = () => view() === 'shop' && !isCli(S.profile);
  function show(html) { const b = box(); if (!b) return; b.hidden = !html; b.innerHTML = html || ''; }
  function setT(v) { const t = $('#o-tarifa'); t.value = v; auto = String(v); t.dispatchEvent(new Event('input', { bubbles: true })); }
  async function calc() {
    if (!on()) { show(''); return; }
    const pick = ($('#o-pick').value || '').trim();
    if (pick.length < 8 || val('o-calle').length < 3 || val('o-col').length < 3) { key = ''; show(''); return; }
    const dest = buildDest(), k = pick + '|' + dest; if (k === key) return; key = k;
    const my = ++seq; show('📏 Calculando distancia…');
    const [a, b] = await Promise.all([geoPoint(pick), geoPoint(dest)]);
    if (my !== seq) return;
    let km = a && b ? hav(a, b) * 1.3 : null; if (km > 60) km = null;
    if (km === null) { show('No pude calcular la distancia. Pon tú la tarifa.'); return; }
    const sug = tarFor(km), t = $('#o-tarifa'), cur = (t.value || '').trim();
    if (!cur || cur === auto) setT(sug);
    show('📏 Distancia aprox.: <b>' + fmtKm(km) + '</b> · Tarifa sugerida: <b>' + pesos(sug) + '</b><small>Puedes cambiarla si lo necesitas. Distancia aproximada © OpenStreetMap.</small>' + (String(t.value) !== String(sug) ? '<button type="button" data-quote="' + sug + '">Usar ' + pesos(sug) + '</button>' : ''));
  }
  const again = () => { clearTimeout(timer); timer = setTimeout(calc, 900); };
  document.addEventListener('input', (e) => { const i = e.target && e.target.id; if (['o-pick', 'o-calle', 'o-num', 'o-int', 'o-col', 'o-ciudad', 'o-mun'].indexOf(i) >= 0) again(); });
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-quote]'); if (b) { setT(b.getAttribute('data-quote')); b.remove(); } });
  setInterval(() => { if (on() && $('#o-pick') && !key) again(); }, 3000);
})();

/* ---------- pedidos cerca de mí: GPS del repartidor, en movimiento ---------- */
(function () {
  let watchId = null, last = null;
  function onPos(p) {
    const c = p && p.coords; if (!c) return;
    S.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 0, t: Date.now() }; S.posErr = '';
    if (!last || hav([last.lat, last.lon], [S.pos.lat, S.pos.lon]) > 0.12) { last = { lat: S.pos.lat, lon: S.pos.lon }; refilter(); } else render();
  }
  function onErr(e) { S.posErr = e && e.code === 1 ? 'denied' : 'fail'; render(); }
  function ctl() {
    const want = view() === 'rider' && S.online && rMode() === 'cerca' && 'geolocation' in navigator;
    if (want && watchId === null) {
      try { watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 15000, timeout: 25000 }); } catch (e) { S.posErr = 'fail'; }
      try { navigator.geolocation.getCurrentPosition(onPos, function () {}, { enableHighAccuracy: false, maximumAge: 600000, timeout: 15000 }); } catch (e) {} /* ubicación rápida por red mientras llega el GPS */
    } else if (!want && watchId !== null) {
      try { navigator.geolocation.clearWatch(watchId); } catch (e) {} watchId = null;
      if (view() !== 'rider' || !S.online) { S.pos = null; last = null; }
    }
  }
  setInterval(ctl, 1500);
  const st = document.createElement('style');
  st.textContent = '#modeBar{margin:10px 0 4px}#modeBar .zl{display:block;font-weight:800;margin:0 0 6px}#modeBar .zc{display:flex;flex-wrap:wrap;gap:8px}#modeBar button{border:2px solid var(--line,#cfd6de);background:#fff;border-radius:99px;padding:8px 14px;min-height:42px;font:inherit;font-weight:700;color:#17212b}#modeBar button.on{background:#f6b400;border-color:#f6b400;color:#16202a}#modeBar .ms{margin:8px 0 0;font-size:14px;font-weight:600;opacity:.8}#modeBar .ms.bad{color:#b3261e;opacity:1}';
  document.head.appendChild(st);
  let sig = '';
  function bar() {
    let el = document.getElementById('modeBar');
    const head = document.getElementById('riderHead');
    const show = head && view() === 'rider' && S.tab === 'disp';
    if (!el && head) { el = document.createElement('div'); el.id = 'modeBar'; head.after(el); }
    if (!el) return;
    el.hidden = !show; if (!show) return;
    const m = rMode(), km = S.radioKm || 3;
    let msg = '', bad = '';
    if (!('geolocation' in navigator)) { msg = 'Tu celular no permite usar la ubicación, no podrás recibir pedidos.'; bad = ' bad'; }
    else if (!S.online) msg = 'Ponte En línea con el GPS encendido para recibir pedidos cerca de ti.';
    else if (S.posErr === 'denied') { msg = 'Tu GPS o el permiso de ubicación está apagado. Actívalo en tu celular (Ajustes → Ubicación → Gasca) para recibir pedidos.'; bad = ' bad'; }
    else if (S.posErr) { msg = 'No se encuentra tu ubicación. Enciende el GPS y sal a un lugar abierto.'; bad = ' bad'; }
    else if (!S.pos) msg = 'Buscando tu ubicación…';
    else msg = '📍 GPS activo. Recibes pedidos a menos de ' + km + ' km de donde estás, aunque te muevas.';
    const s2 = km + '|' + msg;
    if (s2 === sig && el.innerHTML) return; sig = s2;
    el.innerHTML = '<p class="ms' + bad + '">' + esc(msg) + '</p><p class="ms" style="font-weight:500;font-size:12.5px">Tu ubicación se usa solo para mostrarte pedidos cercanos y verificar entregas, solo mientras estás en línea. Consulta el Aviso de privacidad.</p>';
  }
  setInterval(bar, 400);
})();


/* ---------- permiso de ubicación: pantalla que lo pide al entrar (repartidor) ---------- */
(function () {
  let state = 'unknown', skip = false, ov = null, sig = '';
  const q = () => {
    try {
      if (!navigator.permissions || !navigator.permissions.query) { state = 'prompt'; return; }
      navigator.permissions.query({ name: 'geolocation' }).then((r) => { state = r.state; r.onchange = () => { state = r.state; tick(); }; }).catch(() => { state = 'prompt'; });
    } catch (e) { state = 'prompt'; }
  };
  const st = document.createElement('style');
  st.textContent = '#gpsGate{position:fixed;inset:0;z-index:9998;background:#f2f4f7;color:#16202a;display:flex;align-items:center;justify-content:center;padding:22px;overflow:auto}#gpsGate[hidden]{display:none}#gpsGate .gg{max-width:420px;width:100%;text-align:center;display:flex;flex-direction:column;gap:14px}#gpsGate .gi{width:96px;height:96px;margin:0 auto;border-radius:50%;background:#f6b400;display:grid;place-items:center;box-shadow:0 8px 22px rgba(246,180,0,.4)}#gpsGate h2{font-size:26px;margin:4px 0 0;font-weight:800}#gpsGate p{font-size:17px;line-height:1.4;margin:0}#gpsGate .gs{background:#fff;border:1px solid #d9dee5;border-radius:14px;padding:12px 14px;text-align:left;font-size:16px}#gpsGate .gs>b:first-child{display:block;margin-bottom:4px}#gpsGate .gn{background:none;border:0;color:#6b7683;text-decoration:underline;font-size:15px;padding:8px}#gpsGate .btn{min-height:56px;font-size:18px}';
  document.head.appendChild(st);
  function html() {
    const denied = state === 'denied';
    return '<div class="gg"><div class="gi"><svg viewBox="0 0 24 24" width="52" height="52" fill="#16202a"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg></div>' +
      '<h2>' + (denied ? 'Ubicación apagada' : 'Activa tu ubicación') + '</h2>' +
      '<p>Gasca necesita saber dónde estás para mostrarte los pedidos que te quedan cerca. <b>Sin la ubicación no te llegarán pedidos.</b></p>' +
      (denied
        ? '<div class="gs"><b>Para activarla:</b>1. Toca el candadito o los tres puntos de arriba, en el navegador.<br>2. Entra a <b>Configuración del sitio</b> → <b>Ubicación</b>.<br>3. Elige <b>Permitir</b>.<br>4. Regresa aquí y toca "Ya la activé".</div><button type="button" class="btn primary" data-gg="again">Ya la activé</button>'
        : '<button type="button" class="btn primary" data-gg="ask">Permitir ubicación</button><div class="gs"><b>Cuando el celular te pregunte,</b>elige <b>"Permitir mientras usas la app"</b>. Deja Gasca abierta y la pantalla encendida mientras trabajas.</div>') +
      '<button type="button" class="gn" data-gg="skip">Ahora no</button></div>';
  }
  function tick() {
    const need = view() === 'rider' && !skip && (state === 'denied' || (state === 'prompt' && !S.pos)) && 'geolocation' in navigator;
    if (!ov) { ov = document.createElement('div'); ov.id = 'gpsGate'; ov.hidden = true; document.body.appendChild(ov);
      ov.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('[data-gg]'); if (!b) return; const k = b.getAttribute('data-gg');
        if (k === 'skip') { skip = true; tick(); return; }
        const go = () => { try { navigator.geolocation.getCurrentPosition((p) => { state = 'granted'; S.posErr = ''; tick(); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (x) {} }, (er) => { if (er && er.code === 1) state = 'denied'; q(); tick(); }, { enableHighAccuracy: true, timeout: 20000 }); } catch (x) { state = 'denied'; tick(); } };
        if (k === 'again') { q(); setTimeout(() => { if (state === 'denied') toast('Todavía está apagada. Actívala en la configuración del sitio.'); else go(); tick(); }, 400); return; }
        go();
      }); }
    ov.hidden = !need;
    if (need) { const h = html(); if (sig !== h) { ov.innerHTML = h; sig = h; } }
  }
  q(); setInterval(tick, 800); setInterval(q, 15000);
  window.__gpsState = () => state; window.__gpsRefresh = () => { q(); };
})();

/* ---------- correo de recuperación (cuentas con teléfono) ---------- */
const maskMail = (m) => { const [a, d] = String(m || '').split('@'); return a ? a.slice(0, 2) + '***@' + (d || '') : ''; };
async function lookupMail(tel) { try { const sn = await getDoc(doc(db, 'logins', tel)); const v = sn.exists() ? sn.data() : null; return v && v.mail ? String(v.mail).toLowerCase() : ''; } catch (e) { return ''; } }
function myTel() { const t = telOf(S.email); if (t) return t; const m = String((S.profile && S.profile.addr) || '').match(/Tel\s*(\d{10})/); return m ? m[1] : ''; }
async function loadRec() {
  if (!S.uid || S.recFor === S.uid || !S.user) return; S.recFor = S.uid; S.recOn = false; S.recMail = ''; S.recTel = '';
  try {
    const sn = await getDocs(query(collection(db, 'logins'), where('uid', '==', S.uid)));
    sn.docs.forEach((d) => { const v = d.data(); if (v && v.mail && v.uid === S.uid) { S.recOn = true; S.recMail = String(v.mail).toLowerCase(); S.recTel = d.id; lsSet('gasca_rectel_for_' + S.recMail, d.id); lsSet('gasca_realmail_for_' + d.id, S.recMail); } });
  } catch (e) {}
  render();
}
setInterval(() => { try { if (S.user && !S.isAdmin && S.profile) loadRec(); } catch (e) {} }, 1500);
const recEligible = () => !!S.user && !S.isAdmin && (S.recOn || telOf(S.email) || (!S.ownerEmail && /Tel\s*\d{10}/.test((S.profile && S.profile.addr) || '') && !String(S.email).includes('+gasca-')));
async function saveRecovery(mail, pass) {
  const u = auth.currentUser; if (!u) throw new Error('nouser');
  const tel = myTel(); if (!tel) throw new Error('notel');
  if (pass) { const cr = EmailAuthProvider.credential(u.email, pass); await reauthenticateWithCredential(u, cr); }
  await setDoc(doc(db, 'logins', tel), { mail, uid: u.uid, creadoEn: Date.now() });
  try { await verifyBeforeUpdateEmail(u, mail); }
  catch (e) { try { await updateDoc(doc(db, 'logins', tel), { mail: '' }); } catch (x) {} throw e; }
  S.recOn = true; S.recMail = mail; S.recTel = tel; S.recFor = S.uid; lsSet('gasca_rectel_for_' + mail, tel); lsSet('gasca_realmail_for_' + tel, mail);
}
function openRecovery() {
  let ov = document.getElementById('recOv');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'recOv'; document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov || (e.target.closest && e.target.closest('[data-rc=close]'))) ov.hidden = true; });
    ov.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target, er = f.querySelector('.rc-er'), btn = f.querySelector('button[type=submit]');
      const mail = f.mail.value.trim().toLowerCase(), pw = f.pw.value;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { er.textContent = 'Ese correo no se ve bien. Revísalo.'; return; }
      if (!pw) { er.textContent = 'Escribe tu contraseña actual.'; return; }
      er.textContent = ''; btn.disabled = true; btn.textContent = 'Guardando…';
      try { await saveRecovery(mail, pw); ov.innerHTML = recHtml(true); render(); }
      catch (x) { const c = (x && x.code) || ''; er.textContent = /wrong-password|invalid-credential/.test(c) ? 'Esa contraseña no es la tuya.' : c === 'auth/email-already-in-use' ? 'Ese correo ya se usa en otra cuenta. Usa otro.' : c === 'auth/too-many-requests' ? 'Demasiados intentos. Espera unos minutos.' : 'No se pudo guardar. Intenta de nuevo.'; btn.disabled = false; btn.textContent = 'Guardar correo'; }
    });
  }
  ov.innerHTML = recHtml(false); ov.hidden = false;
}
function epHtml(msg) {
  const c = S.cambio, pend = c && c.estado === 'pendiente';
  let top = '';
  if (msg) top = '<p class="rc-st">' + msg + '</p>';
  else if (pend) top = '<p class="rc-st">⏳ Tus cambios están <b>en revisión</b> por la administración. Mientras tanto se usa tu información actual.</p>';
  else if (c && c.estado === 'rechazado') top = '<p class="rc-st">❌ No se aprobaron tus últimos cambios' + (c.motivo ? ': <b>' + esc(c.motivo) + '</b>' : '') + '. Puedes corregirlos y enviarlos otra vez.</p>';
  const tl = (pend || (c && c.estado === 'rechazado')) ? c.tel : (S.profile && S.profile.tel), nm = pend ? c.name : (c && c.estado === 'rechazado' ? c.name : S.name), ad = pend ? c.addr : (c && c.estado === 'rechazado' ? c.addr : S.addr);
  return '<div class="rc"><h3>✏️ Editar perfil</h3>' + top + '<p>Los cambios los revisa la administración antes de aplicarse. Te marcarán a este WhatsApp para confirmar.</p>' +
    '<form autocomplete="off"><label>Nombre del negocio<input name="name" maxlength="60" value="' + esc(nm || '') + '"></label><label>WhatsApp del negocio (10 dígitos)<input name="tel" type="tel" inputmode="numeric" maxlength="10" placeholder="3111234567" value="' + esc(tl || '') + '"></label><label>Dirección del negocio<input name="addr" maxlength="160" placeholder="Calle, número, colonia, ciudad" value="' + esc(ad || '') + '"></label>' +
    '<p class="rc-er" role="alert"></p><button type="submit" class="btn primary block">' + (pend ? 'Reenviar cambios' : 'Enviar para aprobación') + '</button></form><button type="button" class="btn ghost block" data-ep="close">Cerrar</button></div>';
}
function openEditPerfil() {
  let ov = document.getElementById('epOv');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'epOv'; document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov || (e.target.closest && e.target.closest('[data-ep=close]'))) ov.hidden = true; });
    ov.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target, er = f.querySelector('.rc-er'), btn = f.querySelector('button[type=submit]');
      const tel = f.tel.value.replace(/\D/g, ''), name = f.name.value.trim().replace(/\s+/g, ' '), addr = f.addr.value.trim().replace(/\s+/g, ' ');
      if (name.length < 2) { er.textContent = 'Escribe el nombre del negocio.'; return; }
      if (addr.length < 8) { er.textContent = 'Escribe la dirección completa: calle, número, colonia y ciudad.'; return; }
      if (tel.length !== 10) { er.textContent = 'Escribe tu WhatsApp con 10 dígitos.'; return; }
      if (name === (S.name || '') && addr === (S.addr || '') && tel === ((S.profile && S.profile.tel) || '')) { er.textContent = 'No cambiaste nada.'; return; }
      er.textContent = ''; btn.disabled = true; btn.textContent = 'Enviando…';
      try { await setDoc(doc(db, 'cambiosPerfil', S.uid), { uid: S.uid, name, addr, tel, estado: 'pendiente', creadoEn: Date.now() }); S.cambio = { uid: S.uid, name, addr, tel, estado: 'pendiente', creadoEn: Date.now() }; ov.innerHTML = epHtml('✅ Enviado. La administración lo revisará pronto.'); render(); }
      catch (x) { er.textContent = 'No se pudo enviar. Intenta de nuevo.'; btn.disabled = false; btn.textContent = 'Enviar para aprobación'; }
    });
  }
  ov.innerHTML = epHtml(''); ov.hidden = false;
}
function recHtml(done) {
  const confirmed = !telOf(S.email) && S.recOn;
  let body;
  if (done) body = '<p><b>¡Listo!</b> Te mandamos un correo a <b>' + esc(maskMail(S.recMail)) + '</b>. Ábrelo y toca el enlace para <b>confirmar</b>. Hasta entonces no sirve para recuperar la contraseña. Revisa también spam.</p><button type="button" class="btn primary block" data-rc="close">Entendido</button>';
  else {
    body = (S.recOn ? '<p class="rc-st">' + (confirmed ? '✅ Correo confirmado: <b>' + esc(maskMail(S.recMail)) + '</b>' : '⏳ Pendiente de confirmar: <b>' + esc(maskMail(S.recMail)) + '</b>. Revisa tu correo y toca el enlace.') + '</p><p>Si quieres cambiarlo, escribe otro:</p>' : '<p>Si algún día olvidas tu contraseña, te mandamos el enlace a este correo, solo a ti.</p>') +
      '<form autocomplete="off"><label>Tu correo<input name="mail" type="email" autocomplete="email" placeholder="nombre@gmail.com"></label><label>Tu contraseña actual<input name="pw" type="password" autocomplete="current-password"></label><p class="rc-er" role="alert"></p><button type="submit" class="btn primary block">Guardar correo</button></form><button type="button" class="btn ghost block" data-rc="close" style="margin-top:8px">Cerrar</button>';
  }
  return '<div class="rc"><h3>📧 Correo de recuperación</h3>' + body + '</div>';
}
(function () {
  const st = document.createElement('style');
  st.textContent = '#recOv{position:fixed;inset:0;z-index:9991;background:rgba(10,15,20,.6);display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}#recOv[hidden]{display:none}#recOv .rc{background:#fff;color:#16202a;border-radius:22px;max-width:380px;width:100%;padding:20px;display:flex;flex-direction:column;gap:10px}#recOv h3{margin:0;font-size:21px}#recOv p{margin:0;font-size:16px;line-height:1.4}#recOv label{display:flex;flex-direction:column;gap:4px;font-weight:700;font-size:15px;margin-bottom:8px}#recOv input{font:inherit;font-size:17px;border:2px solid #d5dbe3;border-radius:12px;padding:12px;color:#16202a;background:#fff}.rc-er{color:#c0392b;font-weight:700;min-height:0}.rc-st{background:#f2f4f7;border-radius:12px;padding:10px}';
  document.head.appendChild(st);
  const st2 = document.createElement('style'); st2.textContent = st.textContent.split('#recOv').join('#epOv') + '#epOv .btn.ghost,#recOv .btn.ghost,.wzoffer .btn.ghost{background:transparent;color:#16202a;border:2px solid #d5dbe3}.who.wz-nomenu{display:none!important}'; document.head.appendChild(st2);
})();

/* ---------- menú y perfiles múltiples con el mismo correo ---------- */
(function () {
  const SUF = { shop: '+gasca-negocio', rider: '+gasca-repartidor', cliente: '+gasca-personal' };
  const LBL = { shop: 'restaurante', rider: 'repartidor', cliente: 'envíos personales' };
  const ICO = { shop: '🍽️', rider: '🛵', cliente: '📦' };
  const ALLOW = { rider: ['shop', 'cliente'], shop: ['rider'], cliente: ['rider'] };
  const NO_MIX = { shop: 'cliente', cliente: 'shop' };
  const parts = (e) => { e = String(e || '').toLowerCase(); const i = e.lastIndexOf('@'); return i < 1 ? null : { l: e.slice(0, i), d: e.slice(i + 1) }; };
  const suffixKind = (e) => { const p = parts(e); if (!p) return ''; return Object.keys(SUF).find((k) => p.l.endsWith(SUF[k])) || ''; };
  const baseOf = (e) => { if (String(e || '').toLowerCase() === S.email && !telOf(S.email)) { const t = lsGet('gasca_rectel_for_' + S.email); if (t) e = t + TEL_DOM; } const p = parts(e); return p ? p.l.replace(/\+gasca-(negocio|repartidor|personal)$/, '') + '@' + p.d : ''; };
  const aliasOf = (e, k) => { const p = parts(baseOf(e)); return p.l + SUF[k] + '@' + p.d; };
  const bkKey = () => 'gasca_bk_' + baseOf(S.email);
  const myKind = () => isCli(S.profile) ? 'cliente' : (S.role === 'rider' || S.role === 'shop' ? S.role : null);
  function info() {
    if (!S.user || S.isAdmin || S.ownerEmail) return null;
    const sk = suffixKind(S.email);
    if (sk) { const bk = lsGet(bkKey()) || ''; return { cur: sk, back: true, opts: [{ kind: LBL[bk] ? bk : '', target: baseOf(S.email) }] }; }
    const k = myKind(); if (!k) return null;
    if (lsGet(bkKey()) !== k) lsSet(bkKey(), k);
    return { cur: k, back: false, opts: ALLOW[k].map((x) => ({ kind: x, target: aliasOf(S.email, x) })) };
  }
  const optTxt = (o) => o.kind ? 'modo ' + LBL[o.kind] : 'mi otro perfil';
  const st = document.createElement('style');
  st.textContent = '.top{flex-wrap:wrap;row-gap:10px}.top .brand{flex:1 1 100%}.who::before,.who::after{content:none!important}.who{order:4;flex:0 0 auto!important;max-width:none!important;width:auto;min-height:46px;padding:8px 18px!important;border-radius:14px!important;font-size:15px!important;font-weight:800!important;border:2px solid #16202a!important;background:#fff!important;color:#16202a!important;display:flex;align-items:center;white-space:nowrap!important}.who.has-menu{background:#16202a!important;color:#fff!important}#whoName{order:3;flex:1 1 0;min-width:0;display:flex;align-items:center;gap:9px;border:1px solid var(--line,#cfd6de);background:var(--surface,#fff);border-radius:14px;padding:8px 14px;font-size:14px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis}#whoName::before{content:"";flex:0 0 9px;height:9px;border-radius:50%;background:var(--green,#17803F)}#whoName[hidden]{display:none}#gMenu .gm{max-height:88vh;overflow:auto}#gMenu .gl{margin:14px 0 2px;font-size:12.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.6}#gMenu button.tb,#gMenu button.cur{text-align:left;display:flex;align-items:center;justify-content:space-between;border-color:#cfd6de;min-height:50px}#gMenu button.cur{background:#fff3c4;border-color:#f6b400}#gMenu button.sw{border-color:#cfd6de;text-align:left}#gMenu .gbd{background:#b3261e;color:#fff;border-radius:99px;padding:1px 8px;font-size:13px;margin-left:8px}.who.has-menu::after{content:none!important}#gMenu{position:fixed;inset:0;z-index:9000;background:rgba(15,20,28,.55);display:flex;align-items:flex-end;justify-content:center}#gMenu[hidden]{display:none}#gMenu .gm{width:100%;max-width:480px;background:#fff;color:#16202a;border-radius:22px 22px 0 0;padding:20px 18px 26px;box-shadow:0 -10px 40px rgba(0,0,0,.25)}#gMenu h3{margin:0 0 4px;font-size:20px}#gMenu p{margin:4px 0 12px;font-size:14.5px;opacity:.8}#gMenu button{display:block;width:100%;min-height:54px;margin-top:10px;border-radius:16px;border:2px solid #16202a;background:#fff;color:#16202a;font:inherit;font-weight:800;font-size:16.5px;padding:10px 14px}#gMenu button.pri{background:#f6b400;border-color:#f6b400}#gMenu button.dk{background:#16202a;color:#fff}#gMenu button.gh{border-color:#cfd6de;font-weight:700}#gMenu input{width:100%;min-height:50px;border:2px solid #cfd6de;border-radius:14px;padding:8px 12px;font:inherit;font-size:17px;margin-top:8px}#gMenu .er{color:#b3261e;font-weight:700;margin:8px 0 0;font-size:14px}#gMenu .gr{display:grid;grid-template-columns:1fr 1fr;gap:10px}#gMenu .gr button{min-height:110px;font-size:17px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}';
  document.head.appendChild(st);
  const el = document.createElement('div'); el.id = 'gMenu'; el.hidden = true; document.body.appendChild(el);
  { const w0 = $('#who'); if (w0 && !document.getElementById('whoName')) { const n0 = document.createElement('div'); n0.id = 'whoName'; n0.hidden = true; w0.before(n0); } }
  let mode = '', err = '', busy = false, pick = null, chooseOpts = [];
  const close = () => { el.hidden = true; mode = ''; err = ''; pick = null; };
  const gpw = () => (S.pwFor === S.email ? S.pw || '' : '');
  function paint() {
    const i = info();
    if (mode === 'menu' && i) {
      el.innerHTML = '<div class="gm"><h3>☰ Menú</h3><p>' + esc(S.name || '') + ' · modo ' + LBL[i.cur] + '</p>' +
        (S.menuTabs && view() === 'shop' ? '<div class="gl">Ir a</div>' + S.menuTabs.map((t) => '<button class="' + (S.tab === t.id ? 'cur' : 'tb') + '" data-gm="tab" data-t="' + esc(t.id) + '">' + esc(t.label) + (t.badge ? ' <span class="gbd">' + t.badge + '</span>' : '') + (S.tab === t.id ? ' ✓' : '') + '</button>').join('') : '') +
        (S.role === 'shop' && !isCli(S.profile) ? '<button class="tb" data-gm="edit">✏️ Editar perfil</button>' : '') + (recEligible() ? '<button class="tb" data-gm="rec">📧 Correo de recuperación</button>' : '') + '<div class="gl">Cambiar de perfil</div>' +
        i.opts.map((o, n) => '<button class="sw" data-gm="switch" data-k="' + n + '">🔁 Cambiar a ' + optTxt(o) + '</button>').join('') +
        '<button class="dk" data-gm="out">Cerrar sesión</button><button class="gh" data-gm="close">Cerrar menú</button></div>';
    } else if (mode === 'pass' && pick) {
      el.innerHTML = '<div class="gm"><h3>' + (pick.kind ? ICO[pick.kind] + ' ' : '') + 'Cambiar a ' + optTxt(pick) + '</h3><p>Escribe tu contraseña (la misma de siempre) para continuar.</p><input type="password" id="gm-pass" autocomplete="current-password" placeholder="Tu contraseña">' + (err ? '<div class="er">' + esc(err) + '</div>' : '') +
        '<button class="pri" data-gm="go"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Un momento…' : 'Continuar') + '</button><button class="gh" data-gm="close">Cancelar</button></div>';
    } else if (mode === 'choose' && i) {
      const all = [{ kind: i.cur, stay: true }].concat(chooseOpts);
      el.innerHTML = '<div class="gm"><h3>¿Qué quieres hacer hoy?</h3><p>Tienes más de un perfil aprobado. Elige qué vas a hacer ahora.</p><div class="gr">' +
        all.map((o, n) => '<button class="' + (o.stay ? 'pri' : '') + '" data-gm="' + (o.stay ? 'stay' : 'goto') + '" data-k="' + (n - 1) + '"><span style="font-size:34px">' + ICO[o.kind] + '</span>' + ({ rider: 'Repartir', shop: 'Pedir motos para mi negocio', cliente: 'Solicitar un envío' }[o.kind]) + '</button>').join('') + '</div>' + (err ? '<div class="er">' + esc(err) + '</div>' : '') + '</div>';
    } else { mode = ''; }
    el.hidden = !mode;
    const inp = el.querySelector('#gm-pass'); if (inp && !busy) setTimeout(() => inp.focus(), 50);
  }
  const active = () => S.role === 'rider' && S.myOrders && S.myOrders.some((o) => o.driverId === S.uid && (o.estado === 'asignado' || o.estado === 'recogido'));
  let pApp = null, pDb = null;
  const sub = () => { try { pApp = pApp || initializeApp(FIREBASE_CONFIG, 'probe'); return getAuth(pApp); } catch (e) { return null; } };
  async function approvedAlias(email, pass) {
    const a2 = sub(); if (!a2) return false;
    try {
      const cr = await signInWithEmailAndPassword(a2, email, pass); let ok = false;
      try { pDb = pDb || initializeFirestore(pApp, { experimentalAutoDetectLongPolling: true }); const d = await getDoc(doc(pDb, 'aprobaciones', cr.user.uid)); ok = d.exists() && d.data().estado === 'aprobado'; } catch (e) {}
      try { await signOut(a2); } catch (e) {}
      return ok;
    } catch (e) { return false; }
  }
  async function exists(email, pass) {
    const a2 = sub(); if (!a2) return false;
    try { await signInWithEmailAndPassword(a2, email, pass); try { await signOut(a2); } catch (e) {} return true; } catch (e) { return false; }
  }
  async function verifyPass(pass) {
    const a2 = sub(); if (!a2) return true;
    try { await signInWithEmailAndPassword(a2, S.email, pass); try { await signOut(a2); } catch (e) {} return true; } catch (e) { return !(e && /invalid-credential|wrong-password|user-not-found/.test(e.code || '')); }
  }
  async function go(pass, o) {
    const i = info(); if (!i || busy || !o) return;
    if (active()) { err = 'Tienes un pedido activo. Termínalo antes de cambiar de modo.'; paint(); return; }
    busy = true; err = ''; if (mode === 'pass') paint();
    const fail = (m) => { err = m; busy = false; if (!mode) mode = 'pass'; pick = o; paint(); };
    try {
      if (!gpw() || gpw() !== pass) { if (!(await verifyPass(pass))) return fail('Contraseña incorrecta.'); }
      const carry = S.name; lsSet('gasca_online_' + S.uid, '0');
      let used = o.target;
      try {
        try { await signInWithEmailAndPassword(auth, o.target, pass); }
        catch (er0) { const tl0 = telOf(o.target), rm0 = tl0 && lsGet('gasca_realmail_for_' + tl0); if (rm0 && i.back) { await signInWithEmailAndPassword(auth, rm0, pass); used = rm0; } else throw er0; }
        window.__carry = '';
      }
      catch (e) {
        if (i.back) return fail('No se pudo entrar a ese perfil. Revisa tu contraseña.');
        const bad = NO_MIX[o.kind];
        if (bad && await exists(aliasOf(S.email, bad), pass)) return fail('Ya tienes un perfil de ' + LBL[bad] + '. No se puede combinar ' + LBL[o.kind] + ' con ' + LBL[bad] + '.');
        try { await createUserWithEmailAndPassword(auth, o.target, pass); window.__carry = carry || ''; }
        catch (e2) { return fail(e2 && e2.code === 'auth/email-already-in-use' ? 'Ese perfil ya existe con otra contraseña. Entra con esa contraseña.' : authMsg(e2)); }
      }
      S.pw = pass; S.pwFor = used; busy = false; close();
    } catch (e) { fail('No se pudo cambiar. Intenta de nuevo.'); }
  }
  window.__gmOpen = () => { mode = 'menu'; err = ''; paint(); }; window.__gmInfo = info;
  function choose(o) { if (active()) { close(); toast('Tienes un pedido activo. Termínalo antes de cambiar de modo.'); return; } if (gpw()) { pick = o; mode = ''; go(gpw(), o); } else { pick = o; mode = 'pass'; err = ''; paint(); } }
  document.addEventListener('click', (e) => {
    const w = e.target.closest && e.target.closest('#who');
    if (w && w.classList.contains('has-menu')) { e.stopImmediatePropagation(); e.preventDefault(); mode = 'menu'; err = ''; paint(); return; }
    const b = e.target.closest && e.target.closest('#gMenu [data-gm]');
    if (!b) { if (e.target === el) close(); return; }
    const a = b.getAttribute('data-gm'), i = info(), k = Number(b.getAttribute('data-k'));
    if (a === 'close' || a === 'stay') close();
    else if (a === 'out') { close(); doSignOut(); }
    else if (a === 'rec') { close(); openRecovery(); }
    else if (a === 'edit') { close(); openEditPerfil(); }
    else if (a === 'tab') { S.tab = b.getAttribute('data-t'); S.cancelId = null; close(); render(); try { window.scrollTo(0, 0); } catch (er) {} }
    else if (a === 'switch' && i && i.opts[k]) choose(i.opts[k]);
    else if (a === 'goto' && chooseOpts[k]) choose(chooseOpts[k]);
    else if (a === 'go') { const v = (el.querySelector('#gm-pass') || {}).value || ''; if (v.length < 6) { err = 'Escribe tu contraseña.'; paint(); return; } go(v, pick); }
  }, true);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && mode === 'pass') { const v = (el.querySelector('#gm-pass') || {}).value || ''; if (v.length >= 6) go(v, pick); } });
  let pend = null;
  af.addEventListener('submit', () => {
    if (S.authMode !== 'login') return;
    const em = $('#a-email').value.trim().toLowerCase(), pw = $('#a-pass').value;
    const e2 = em.indexOf('@') > 0 ? em : telEmail(em);
    if (e2 && pw) pend = { email: e2, pass: pw };
  }, true);
  async function probe(p) {
    const i = info(); if (!i || i.back) return;
    const v0 = view(); if (v0 !== 'shop' && v0 !== 'rider') return;
    const res = await Promise.all(i.opts.map((o) => approvedAlias(o.target, p.pass)));
    const found = i.opts.filter((o, n) => res[n]);
    if (found.length && S.user && S.email === p.email && !mode) { chooseOpts = found; mode = 'choose'; err = ''; paint(); }
  }
  setInterval(() => {
    try { wzMenuVis(); } catch (e) {}
    const who = $('#who'); if (who) {
      const v = S.user ? view() : '', hm = v === 'shop' || v === 'rider';
      who.classList.toggle('has-menu', hm);
      const lb = hm ? '☰ Menú' : 'Salir'; if (who.textContent !== lb) who.textContent = lb;
      let nm = document.getElementById('whoName');
      if (!nm) { nm = document.createElement('div'); nm.id = 'whoName'; who.before(nm); }
      nm.hidden = who.hidden;
    }
    if (!S.user) { S.pw = ''; if (mode) close(); }
    if (pend && S.user && S.ready) {
      const v = view(); if (v === 'loading' || v === 'auth') return;
      const p = pend; pend = null;
      { const same = S.email === p.email || (!!telOf(p.email) && lsGet('gasca_rectel_for_' + S.email) === telOf(p.email)); if (same) { p.email = S.email; S.pw = p.pass; S.pwFor = S.email; if (!suffixKind(S.email)) probe(p); } }
    }
    window.__aliasProf = false;
    if (S.user && view() === 'profile') {
      const sk = suffixKind(S.email);
      if (sk) {
        window.__aliasProf = true;
        const rd = af.querySelector('input[name=role][value=' + sk + ']');
        if (rd && !rd.checked) { rd.checked = true; rd.dispatchEvent(new Event('change', { bubbles: true })); }
        const nm = $('#a-name'); if (nm && !nm.value && window.__carry) nm.value = window.__carry;
        const tt = 'Alta de tu perfil de ' + LBL[sk], ld = 'Usas el mismo correo y la misma contraseña. Llena los datos; la administración los revisará antes de aprobarlo.';
        if (!$('#authRoles').hidden) $('#authRoles').hidden = true;
        if ($('#authTitle').textContent !== tt) $('#authTitle').textContent = tt;
        if ($('#authLede').textContent !== ld) $('#authLede').textContent = ld;
      }
    }
  }, 400);
})();
