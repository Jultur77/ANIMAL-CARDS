// Accès à Supabase. Le client ne fait que LIRE (RLS) et appeler des RPC serveur.
import { CONFIG } from '../config.js';

export const configured = /^https:\/\/.+/.test(CONFIG.supabaseUrl) && CONFIG.supabaseAnonKey.length > 20;

export const sb = configured
  ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

function message(error) {
  const text = error?.message || String(error || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(text)) return 'Connexion au serveur impossible. Vérifie ta connexion Internet.';
  if (/JWT|token/i.test(text)) return 'Ta session a expiré. Reconnecte-toi.';
  if (/permission denied/i.test(text)) return 'Action refusée par le serveur.';
  if (/Could not find the function/i.test(text)) return 'Le schéma SQL n’est pas installé ou pas à jour (voir README).';
  return text || 'Une erreur inattendue est survenue.';
}
export class GameError extends Error {}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new GameError(message(error));
  return data;
}
async function select(query) {
  const { data, error } = await query;
  if (error) throw new GameError(message(error));
  return data;
}

export const auth = {
  async session() { return (await sb.auth.getSession()).data.session; },
  onChange(callback) { return sb.auth.onAuthStateChange((event, session) => callback(event, session)); },
  async signUp(email, password, username) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { username }, emailRedirectTo: location.href.split('#')[0] }
    });
    if (error) throw new GameError(authMessage(error));
    return data;
  },
  async signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new GameError(authMessage(error));
    return data;
  },
  async signOut() { await sb.auth.signOut(); },
  async resetPassword(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    if (error) throw new GameError(authMessage(error));
  },
  async updatePassword(password) {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new GameError(authMessage(error));
  }
};
function authMessage(error) {
  const text = error?.message || '';
  if (/Invalid login credentials/i.test(text)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(text)) return 'Confirme d’abord ton adresse e-mail (lien reçu par mail).';
  if (/already registered|already exists/i.test(text)) return 'Un compte existe déjà avec cette adresse.';
  if (/Password should be/i.test(text)) return 'Mot de passe trop court (8 caractères minimum).';
  if (/rate limit/i.test(text)) return 'Trop de tentatives. Patiente un peu avant de réessayer.';
  return message(error);
}

export const api = {
  getState: () => rpc('get_state'),
  createProfile: username => rpc('create_profile', { p_username: username }),
  claimIncome: () => rpc('claim_income'),
  buyBooster: (slot, requestId) => rpc('buy_booster', { p_slot: slot, p_request_id: requestId }),
  createListing: (instance, kind, price, minutes) =>
    rpc('create_listing', { p_instance: instance, p_kind: kind, p_price: price, p_minutes: minutes }),
  cancelListing: id => rpc('cancel_listing', { p_id: id }),
  buyListing: id => rpc('buy_listing', { p_id: id }),
  placeBid: (id, amount) => rpc('place_bid', { p_id: id, p_amount: amount }),
  refreshMarket: () => rpc('refresh_market'),
  createTrade: (instance, wanted) => rpc('create_trade', { p_instance: instance, p_wanted: wanted }),
  cancelTrade: id => rpc('cancel_trade', { p_id: id }),
  acceptTrade: id => rpc('accept_trade', { p_id: id }),

  catalog: () => Promise.all([
    select(sb.from('cards').select('*').order('number')),
    select(sb.from('rarities').select('*').order('id')),
    select(sb.from('settings').select('*').single())
  ]),
  inventory: uid => select(sb.from('card_instances').select('id, card_id, lock_kind, lock_id, origin, acquired_at')
    .eq('owner_id', uid).order('acquired_at', { ascending: false }).limit(5000)),
  discoveries: uid => select(sb.from('discoveries').select('card_id, luck_gained, reward, discovered_at').eq('player_id', uid)),
  activeListings: () => select(sb.from('listings').select('*').eq('status', 'active').order('ends_at').limit(300)),
  salesHistory: () => select(sb.from('listings').select('*').eq('status', 'sold').order('closed_at', { ascending: false }).limit(60)),
  openTrades: () => select(sb.from('trades').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(300)),
  tradeHistory: () => select(sb.from('trades').select('*').eq('status', 'accepted').order('closed_at', { ascending: false }).limit(40)),

  watchMarket(onChange) {
    const channel = sb.channel('marche')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'listings' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trades' }, onChange)
      .subscribe();
    return () => sb.removeChannel(channel);
  }
};
