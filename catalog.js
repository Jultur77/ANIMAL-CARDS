import { randomInt } from 'node:crypto';

export const SHOP_MS = 300_000;
export const MONEY_SCALE = 1000;
export const STARTING_BALANCE = 2_400_000;
export const RARITIES = [
  { id: 'common', name: 'Commun', color: '#a5b9b0', value: 30, income: 300, luck: 1, reward: 8, price: 120, stock: 12 },
  { id: 'uncommon', name: 'Peu commun', color: '#66dc96', value: 100, income: 700, luck: 5, reward: 20, price: 380, stock: 8 },
  { id: 'rare', name: 'Rare', color: '#69b9ff', value: 360, income: 1800, luck: 20, reward: 55, price: 1300, stock: 5 },
  { id: 'epic', name: 'Épique', color: '#b296ff', value: 1400, income: 4000, luck: 100, reward: 150, price: 4800, stock: 3 },
  { id: 'legendary', name: 'Légendaire', color: '#f7cb72', value: 6500, income: 10000, luck: 500, reward: 450, price: 18000, stock: 2 },
  { id: 'mythic', name: 'Mythique', color: '#f58db8', value: 32000, income: 25000, luck: 1500, reward: 1200, price: 72000, stock: 1 },
  { id: 'secret', name: 'Secret', color: '#a4f5eb', value: 160000, income: 60000, luck: 5000, reward: 4000, price: 300000, stock: 1 }
];

const groups = [
  [
    ['red-fox', 'Renard roux', 'Red fox', 'Forêts & clairières', '🦊'],
    ['rabbit', 'Lapin de garenne', 'European rabbit', 'Prairies', '🐇'],
    ['hedgehog', 'Hérisson', 'European hedgehog', 'Sous-bois', '🦔'],
    ['mallard', 'Canard colvert', 'Mallard', 'Lacs & rivières', '🦆'],
    ['clownfish', 'Poisson-clown', 'Ocellaris clownfish', 'Récifs coralliens', '🐠'],
    ['ladybird', 'Coccinelle', 'Coccinella septempunctata', 'Jardins & prairies', '🐞'],
    ['sparrow', 'Moineau', 'House sparrow', 'Villes & campagnes', '🐦'],
    ['squirrel', 'Écureuil roux', 'Red squirrel', 'Forêts tempérées', '🐿️']
  ],
  [
    ['raccoon', 'Raton laveur', 'Raccoon', 'Forêts & rivières', '🦝'],
    ['otter', 'Loutre', 'Eurasian otter', 'Rivières', '🦦'],
    ['flamingo', 'Flamant rose', 'Greater flamingo', 'Lagunes', '🦩'],
    ['toucan', 'Toucan toco', 'Toco toucan', 'Forêts tropicales', '🦜'],
    ['iguana', 'Iguane vert', 'Green iguana', 'Canopées tropicales', '🦎'],
    ['monarch', 'Papillon monarque', 'Monarch butterfly', 'Prairies fleuries', '🦋'],
    ['seahorse', 'Hippocampe', 'Hippocampus kuda', 'Herbiers marins', '🐠'],
    ['meerkat', 'Suricate', 'Meerkat', 'Déserts & savanes', '🐾']
  ],
  [
    ['wolf', 'Loup gris', 'Wolf', 'Forêts boréales', '🐺'],
    ['eagle', 'Aigle royal', 'Golden eagle', 'Massifs montagneux', '🦅'],
    ['crocodile', 'Crocodile du Nil', 'Nile crocodile', 'Fleuves africains', '🐊'],
    ['cobra', 'Cobra royal', 'King cobra', 'Forêts asiatiques', '🐍'],
    ['sea-turtle', 'Tortue verte', 'Green sea turtle', 'Océans tropicaux', '🐢'],
    ['octopus', 'Poulpe commun', 'Common octopus', 'Fonds marins', '🐙'],
    ['snowy-owl', 'Harfang des neiges', 'Snowy owl', 'Toundra arctique', '🦉'],
    ['manta', 'Raie manta', 'Giant oceanic manta ray', 'Océans ouverts', '🌊']
  ],
  [
    ['tiger', 'Tigre', 'Tiger', 'Forêts asiatiques', '🐅'],
    ['elephant', 'Éléphant de savane', 'African bush elephant', 'Savanes africaines', '🐘'],
    ['panda', 'Panda géant', 'Giant panda', 'Forêts de bambous', '🐼'],
    ['gorilla', 'Gorille des montagnes', 'Mountain gorilla', 'Forêts d’altitude', '🦍'],
    ['polar-bear', 'Ours polaire', 'Polar bear', 'Banquise arctique', '🐻‍❄️'],
    ['leopard', 'Léopard', 'Leopard', 'Savanes & forêts', '🐆'],
    ['hammerhead', 'Requin-marteau', 'Great hammerhead', 'Mers tropicales', '🦈'],
    ['komodo', 'Dragon de Komodo', 'Komodo dragon', 'Îles indonésiennes', '🦎']
  ],
  [
    ['lion', 'Lion', 'Lion', 'Savanes africaines', '🦁'],
    ['snow-leopard', 'Panthère des neiges', 'Snow leopard', 'Sommets de l’Himalaya', '🐆'],
    ['orca', 'Orque', 'Orca', 'Océans du monde', '🐋'],
    ['great-white', 'Grand requin blanc', 'Great white shark', 'Océans tempérés', '🦈'],
    ['blue-whale', 'Baleine bleue', 'Blue whale', 'Grands océans', '🐋'],
    ['golden-pheasant', 'Faisan doré', 'Golden pheasant', 'Forêts de montagne', '🪶'],
    ['red-panda', 'Panda roux', 'Red panda', 'Forêts de l’Himalaya', '🐾'],
    ['jaguar', 'Jaguar', 'Jaguar', 'Forêts amazoniennes', '🐆']
  ],
  [
    ['axolotl', 'Axolotl', 'Axolotl', 'Lacs du Mexique', '💧'],
    ['narwhal', 'Narval', 'Narwhal', 'Océan Arctique', '🐋'],
    ['whale-shark', 'Requin-baleine', 'Whale shark', 'Océans tropicaux', '🦈'],
    ['okapi', 'Okapi', 'Okapi', 'Forêts du Congo', '🦒'],
    ['shoebill', 'Bec-en-sabot', 'Shoebill', 'Marais africains', '🪶'],
    ['saola', 'Saola', 'Saola', 'Forêts annamitiques', '🦌'],
    ['pangolin', 'Pangolin', 'Sunda pangolin', 'Forêts tropicales', '🐾'],
    ['quetzal', 'Quetzal resplendissant', 'Resplendent quetzal', 'Forêts de nuages', '🦜']
  ],
  [
    ['tyrannosaurus', 'Tyrannosaurus rex', 'Tyrannosaurus', 'Crétacé supérieur', '🦖'],
    ['triceratops', 'Tricératops', 'Triceratops', 'Crétacé supérieur', '🦕'],
    ['stegosaurus', 'Stégosaure', 'Stegosaurus', 'Jurassique supérieur', '🦕'],
    ['velociraptor', 'Vélociraptor', 'Velociraptor', 'Crétacé supérieur', '🦖'],
    ['spinosaurus', 'Spinosaure', 'Spinosaurus', 'Crétacé', '🦖'],
    ['mammoth', 'Mammouth laineux', 'Woolly mammoth', 'Pléistocène', '🦣'],
    ['smilodon', 'Smilodon', 'Smilodon', 'Pléistocène', '🐅'],
    ['dodo', 'Dodo', 'Dodo', 'Île Maurice · espèce disparue', '🦤']
  ]
];

export const CARDS = groups.flatMap((group, rarity) => group.map(([id, name, wiki, habitat, emoji], position) => ({
  id, name, wiki, habitat, emoji, rarity,
  number: rarity * 8 + position + 1,
  value: Math.round(RARITIES[rarity].value * (1 + position * 0.07)),
  income: RARITIES[rarity].income,
  luck: RARITIES[rarity].luck,
  reward: RARITIES[rarity].reward * MONEY_SCALE,
  image: `/animals/${id}.jpg`
})));
export const CARD_BY_ID = new Map(CARDS.map(card => [card.id, card]));
export const BASE_SHOP_WEIGHTS = [56, 25, 12, 5, 1.5, 0.45, 0.05];
export const PACK_WEIGHTS = [
  [78, 17, 4, 0.85, 0.13, 0.019, 0.001],
  [42, 40, 14, 3.3, 0.6, 0.09, 0.01],
  [20, 30, 37, 10.8, 1.9, 0.27, 0.03],
  [10, 18, 32, 32, 7, 0.9, 0.1],
  [5, 10, 20, 35, 26, 3.6, 0.4],
  [2, 5, 12, 26, 35, 18, 2],
  [0, 0, 5, 10, 25, 40, 20]
];

export function shopProbabilities(luckMilliPercent = 0) {
  const multiplier = 1 + luckMilliPercent / 100_000;
  const weights = BASE_SHOP_WEIGHTS.map((weight, tier) => weight * multiplier ** tier);
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(weight => weight / sum);
}

export function weightedPick(weights, random = () => randomInt(0, 1_000_000_000) / 1_000_000_000) {
  let roll = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

export function drawPack(tier) {
  const result = [];
  for (let i = 0; i < 4; i++) {
    const rarity = i === 3 ? Math.max(tier, weightedPick(PACK_WEIGHTS[tier])) : weightedPick(PACK_WEIGHTS[tier]);
    const pool = groups[rarity];
    result.push(CARD_BY_ID.get(pool[randomInt(pool.length)][0]));
  }
  return result;
}
