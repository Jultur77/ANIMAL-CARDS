import { initializeApp } from 'firebase/app';
import {
  getAuth, setPersistence, browserLocalPersistence, browserSessionPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updateProfile, onAuthStateChanged, sendPasswordResetEmail, connectAuthEmulator
} from 'firebase/auth';
import {
  getFirestore, doc, collection, getDocFromServer,
  onSnapshot, query, where, orderBy, limit, connectFirestoreEmulator
} from 'firebase/firestore';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { firebaseConfig } from '../public/firebase-config.js';

const identifier = () => crypto.randomUUID();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(value);
const knownRejections = new Set(['permission-denied', 'invalid-argument', 'failed-precondition', 'not-found', 'already-exists', 'out-of-range', 'unauthenticated']);
const errorCode = error => String(error?.code || '').replace(/^functions\//, '');
export function userMessage(error) {
  const messages = {
    'auth/invalid-email': 'Cette adresse e-mail semble incorrecte.',
    'auth/invalid-credential': 'Adresse e-mail ou mot de passe incorrect.',
    'auth/email-already-in-use': 'Un compte utilise déjà cette adresse. Connecte-toi ou réinitialise ton mot de passe.',
    'auth/weak-password': 'Choisis un mot de passe d’au moins douze caractères.',
    'auth/too-many-requests': 'Trop de tentatives. Patiente avant de réessayer.',
    'auth/operation-not-allowed': 'Active la connexion par e-mail dans Firebase Authentication.',
    'auth/unauthorized-domain': 'Le domaine de ce site doit être autorisé dans Firebase Authentication.',
    'auth/network-request-failed': 'La connexion à Firebase a été interrompue.',
    'auth/configuration-not-found': 'Firebase Authentication doit encore être configuré pour ce projet.',
    'permission-denied': 'Le serveur a refusé cette opération. Vérifie les autorisations et la configuration App Check ; les écritures directes doivent rester interdites.',
    'unavailable': 'Firebase est inaccessible. Vérifie la transaction en attente avant un nouvel achat.',
    'resource-exhausted': 'La limite de requêtes ou le quota disponible est atteint. Patiente avant de réessayer.',
    'failed-precondition': error?.message || 'Les conditions nécessaires à cette action ne sont pas réunies.',
    'unauthenticated': 'Ta session a expiré ou n’a pas pu être vérifiée. Reconnecte-toi.',
    'aborted': 'Une transaction concurrente est passée avant celle-ci. Reprends la transaction en attente avec le même identifiant.',
    'deadline-exceeded': 'La confirmation a pris trop de temps. Vérifie la transaction en attente avant de recommencer.',
    'internal': 'La confirmation serveur est indisponible. Vérifie la transaction en attente avant de recommencer.'
  };
  return messages[errorCode(error)] || error?.message || 'L’opération n’a pas pu être terminée.';
}
export class GameGateway {
  constructor() {
    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    this.db = getFirestore(this.app);
    this.functions = getFunctions(this.app, 'europe-west1');
    this.busy = false;
    this.pendingError = '';
    if (__FIREBASE_EMULATORS__) {
      if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('Cette compilation de test ne doit pas être publiée.');
      connectAuthEmulator(this.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(this.db, '127.0.0.1', 8080);
      connectFunctionsEmulator(this.functions, '127.0.0.1', 5001);
    }
    this.callAction = httpsCallable(this.functions, 'gameAction', { timeout: 35000 });
  }
  async ready() {
    try { await setPersistence(this.auth, browserLocalPersistence); }
    catch { await setPersistence(this.auth, browserSessionPersistence); }
    await this.auth.authStateReady();
  }
  watchAuth(callback) { return onAuthStateChanged(this.auth, callback); }
  get user() { return this.auth.currentUser; }
  profileRef(uid) { return doc(this.db, 'players', uid); }
  eventRef(id) { return doc(this.db, 'events', id); }
  listingRef(id) { return doc(this.db, 'listings', id); }
  pendingKey() {
    if (!this.user) throw new Error('Connecte-toi pour continuer.');
    return `animal-cards.firebase.pending.${firebaseConfig.projectId}.${this.user.uid}`;
  }
  pending() {
    this.pendingError = '';
    try {
      const raw = localStorage.getItem(this.pendingKey());
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (!validId(item.id) || item.actor !== this.user.uid || typeof item.kind !== 'string' || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)) throw new Error('Transaction locale invalide.');
      return item;
    } catch (error) {
      this.pendingError = 'Le suivi local de la transaction est inaccessible ou illisible. Ne crée pas de nouvel achat avant vérification.';
      throw new Error(this.pendingError, { cause: error });
    }
  }
  async register(email, password, username) {
    if (password.length < 12) throw new Error('Choisis un mot de passe d’au moins douze caractères.');
    if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) throw new Error('Le pseudo doit contenir entre 3 et 24 lettres, chiffres, tirets ou underscores.');
    const credential = await createUserWithEmailAndPassword(this.auth, email.trim(), password);
    await updateProfile(credential.user, { displayName: username });
    return credential.user;
  }
  async login(email, password) { return signInWithEmailAndPassword(this.auth, email.trim(), password); }
  async resetPassword(email) { await sendPasswordResetEmail(this.auth, email.trim()); }
  async logout() {
    if (this.busy || this.pending()) throw new Error('Vérifie la transaction en attente avant de te déconnecter.');
    await signOut(this.auth);
  }
  watchProfile(next, failure) {
    if (!this.user) throw new Error('Connexion nécessaire.');
    return onSnapshot(this.profileRef(this.user.uid), { includeMetadataChanges: true }, snapshot => {
      if (snapshot.metadata.hasPendingWrites) return;
      next(snapshot.exists() ? snapshot.data() : null, { fromCache: snapshot.metadata.fromCache });
    }, failure);
  }
  async readProfile() {
    const snapshot = await getDocFromServer(this.profileRef(this.user.uid));
    return snapshot.exists() ? snapshot.data() : null;
  }
  async readReceipt(id) {
    const snapshot = await getDocFromServer(this.eventRef(id));
    return snapshot.exists() ? snapshot.data() : null;
  }
  watchMarket(type, next, failure) {
    const status = type === 'history' ? ['sold', 'accepted', 'expired', 'cancelled'] : ['active'];
    const clauses = [where('status', 'in', status)];
    if (type !== 'history') clauses.push(where('type', '==', type));
    clauses.push(orderBy('createdAt', 'desc'), limit(40));
    return onSnapshot(query(collection(this.db, 'listings'), ...clauses), { includeMetadataChanges: true }, snapshot => {
      if (!snapshot.metadata.hasPendingWrites) next(snapshot.docs.map(item => item.data()), { fromCache: snapshot.metadata.fromCache });
    }, failure);
  }
  async action(kind, data = {}, retry = false) {
    if (!this.user) throw new Error('Connecte-toi pour continuer.');
    if (this.busy) throw new Error('Une transaction est déjà en cours.');
    const old = this.pending();
    if (old && !retry) throw new Error('Vérifie la transaction en attente avant une nouvelle action.');
    if (retry && !old) throw new Error('Il n’y a aucune transaction en attente.');
    const action = old || { id: identifier(), actor: this.user.uid, kind, data };
    const pendingKey = this.pendingKey();
    localStorage.setItem(pendingKey, JSON.stringify(action));
    this.busy = true;
    try {
      const response = await this.callAction({ id: action.id, kind: action.kind, data: action.data });
      const result = response.data;
      if (result?.id !== action.id || result.kind !== action.kind || typeof result.alreadyApplied !== 'boolean'
        || !Array.isArray(result.revealed) || result.revealed.some(id => typeof id !== 'string')) {
        throw new Error('Confirmation serveur illisible. Vérifie la transaction en attente avant de recommencer.');
      }
      localStorage.removeItem(pendingKey);
      return result;
    } catch (error) {
      if (!old && knownRejections.has(errorCode(error))) localStorage.removeItem(pendingKey);
      throw error;
    } finally { this.busy = false; }
  }
  retryPending() { return this.action('', {}, true); }
}
