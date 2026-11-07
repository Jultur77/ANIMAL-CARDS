import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { error as logError } from 'firebase-functions/logger';
import { createGameService, GameError } from './game-service.js';

initializeApp();
const execute = createGameService({ db: getFirestore() });

export const gameAction = onCall({
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 30,
  minInstances: 0,
  maxInstances: 2,
  concurrency: 20,
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== 'true'
}, async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Connecte-toi pour continuer.');
  try {
    return await execute(request.auth.uid, request.data);
  } catch (error) {
    if (error instanceof GameError) throw new HttpsError(error.code, error.message);
    if (error.code === 10 || error.code === 'aborted') {
      throw new HttpsError('aborted', 'Une autre transaction est passée avant celle-ci. Réessaie avec le même identifiant.');
    }
    if (error.code === 14 || error.code === 'unavailable') {
      throw new HttpsError('unavailable', 'La base est momentanément indisponible. Vérifie la transaction en attente.');
    }
    logError('gameAction: échec interne', { code: String(error.code || 'unknown').slice(0, 80) });
    throw new HttpsError('internal', 'La confirmation est indisponible. Vérifie la transaction en attente avant de recommencer.');
  }
});
