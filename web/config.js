// Configuration publique du jeu.
// ⚠️ N'y mets QUE l'URL du projet et la clé publique (publishable / anon). JAMAIS la clé secrète.
// Supabase > Project Settings > API Keys / Data API.
// Si le workflow GitHub Actions trouve les variables SUPABASE_URL et SUPABASE_ANON_KEY
// (Settings > Secrets and variables > Actions > Variables), il réécrit ce fichier au déploiement.
export const CONFIG = {
  supabaseUrl: 'https://iyhhrnjkdodeldkafqwz.supabase.co',
  supabaseAnonKey: 'sb_publishable_caQ-PimTWMEpXrXSHvc2Mg_fFc75TVB'
};
