/**
 * Fictional Malwa-style name vocabulary (SPEC 14, A1: everything is invented;
 * A39: recorded pool). First + surname pools are disjoint from the fixed cast
 * (Rahul Chouhan, Neha Solanki, Imran Qureshi), firms follow the classic
 * Malwa trading-name patterns ("Kshipra Namkeen Udyog" is the SPEC's own
 * example shape). No pool entry is a real person record — A1 covers this.
 */

export const FIRST_NAMES = [
  'Ghanshyam', 'Bhavna', 'Kanchan', 'Devdatt', 'Shobharam', 'Manisha', 'Lalitkumar', 'Rukminibai',
  'Bhavutsingh', 'Ashvini', 'Pradeepkumar', 'Kamlabai', 'Dineshchandra', 'Gulab', 'Bhagirath',
  'Savitabai', 'Maheshchandra', 'Leela', 'Jagdishchandra', 'Rekhibai', 'Navrang', 'Sushilabai',
  'Kishorchandra', 'Farzana', 'Kaluram', 'Vimalben', 'Zakir', 'Pritibala', 'Chandrakant', 'Geetabai'
] as const;

export const SURNAMES = [
  'Bhabhor', 'Meda', 'Darji', 'Mandlecha', 'Kharadi', 'Vakharia', 'Tilkar', 'Chhilwar', 'Girada',
  'Nirala', 'Sarraf', 'Bhasker', 'Vasoya', 'Bharatiya', 'Lakhani', 'Panwar', 'Bijalwan', 'Rokadiya',
  'Surjeet', 'Badgujar', 'Dholakia', 'Chipa', 'Rana', 'Mansuri', 'Bardolia', 'Khatri', 'Solankli',
  'Kevadiya', 'Ahir', 'Tikam'
] as const;

export const FIRM_PREFIXES = [
  'Shree', 'Maa Umiya', 'Kshipra', 'Avanti', 'Malwa', 'Rajwada', 'Narmada', 'Shipra-Vatika',
  'Anant', 'Paan', 'Dewasvani', 'Digamber', 'Bagheshvari', 'Khajrana'
] as const;

const FIRM_SUFFIXES: Record<'manufacturer' | 'trader' | 'service', readonly string[]> = {
  manufacturer: ['Namkeen Udyog', 'Works', 'Plastic Industries', 'Steel Udyog', 'Garments', 'Agro Industries', 'Apparel Works'],
  trader: ['Kirana & General Store', 'Traders', 'Trading Co', 'Hardware & Paints', 'Kirana Store', 'Agencies', 'Provision Store'],
  service: ['Service Point', 'Studio', 'Photocopy & Cyber', 'Repair Works', 'Motors', 'Beauty Parlour', 'Tiffin Centre']
};

/** Deterministic, unique borrower names: full cross product shuffled once, so
 *  the same seed hands out the exact same 263 names. */
export function borrowerNamePool(rng: () => number, count: number): string[] {
  const combos: string[] = [];
  for (const first of FIRST_NAMES) {
    for (const surname of SURNAMES) {
      combos.push(`${first} ${surname}`);
    }
  }
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = combos[i]!;
    combos[i] = combos[j]!;
    combos[j] = swap;
  }
  if (count > combos.length) {
    throw new Error(`borrowerNamePool: ${count} exceeds pool size ${combos.length}`);
  }
  return combos.slice(0, count);
}

export function firmSuffixesFor(segment: 'manufacturer' | 'trader' | 'service'): readonly string[] {
  return FIRM_SUFFIXES[segment];
}

export function firmName(rng: () => number, segment: 'manufacturer' | 'trader' | 'service'): string {
  const prefixes = FIRM_PREFIXES;
  const suffixes = firmSuffixesFor(segment);
  const prefix = prefixes[Math.floor(rng() * prefixes.length)]!;
  const suffix = suffixes[Math.floor(rng() * suffixes.length)]!;
  return `${prefix} ${suffix}`;
}
