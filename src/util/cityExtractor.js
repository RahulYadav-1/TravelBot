/**
 * Smart city detector. Goes beyond a hardcoded regex by also matching
 * preposition-led capitalized phrases ("flights to Reykjavik") so the bot
 * doesn't lose location context when the user mentions a city not in the
 * known set.
 */

const KNOWN_CITIES_RAW = [
  // North America
  'New York', 'NYC', 'Los Angeles', 'LA', 'Chicago', 'Houston', 'Phoenix',
  'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin',
  'Jacksonville', 'Fort Worth', 'Columbus', 'Charlotte', 'Indianapolis',
  'San Francisco', 'Seattle', 'Denver', 'Washington', 'Washington DC',
  'Boston', 'El Paso', 'Nashville', 'Detroit', 'Oklahoma City', 'Portland',
  'Las Vegas', 'Memphis', 'Louisville', 'Baltimore', 'Milwaukee',
  'Albuquerque', 'Tucson', 'Fresno', 'Sacramento', 'Mesa', 'Atlanta',
  'Kansas City', 'Miami', 'Orlando', 'Tampa', 'New Orleans', 'Minneapolis',
  'St Louis', 'Saint Louis', 'Pittsburgh', 'Cincinnati', 'Honolulu',
  'Anchorage', 'Salt Lake City',
  'Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Edmonton', 'Ottawa',
  'Quebec', 'Winnipeg', 'Halifax',
  'Mexico City', 'Cancun', 'Guadalajara', 'Monterrey', 'Tijuana',
  'Havana', 'San Juan', 'Kingston', 'Panama City', 'Guatemala City',

  // South America
  'Rio', 'Rio de Janeiro', 'Sao Paulo', 'Brasilia', 'Salvador', 'Recife',
  'Manaus', 'Buenos Aires', 'Cordoba', 'Mendoza', 'Santiago', 'Lima',
  'Cusco', 'Bogota', 'Medellin', 'Cartagena', 'Cali', 'Quito',
  'Guayaquil', 'Caracas', 'La Paz', 'Asuncion', 'Montevideo',

  // Western Europe
  'London', 'Manchester', 'Birmingham', 'Liverpool', 'Leeds', 'Glasgow',
  'Edinburgh', 'Cardiff', 'Belfast', 'Dublin', 'Cork',
  'Paris', 'Lyon', 'Marseille', 'Nice', 'Bordeaux', 'Toulouse', 'Strasbourg',
  'Cannes',
  'Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht',
  'Brussels', 'Antwerp', 'Bruges', 'Luxembourg',
  'Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart',
  'Dusseldorf', 'Leipzig', 'Dresden',
  'Vienna', 'Salzburg', 'Innsbruck',
  'Zurich', 'Geneva', 'Bern', 'Basel',
  'Rome', 'Milan', 'Naples', 'Florence', 'Venice', 'Turin', 'Bologna',
  'Palermo', 'Verona', 'Pisa',
  'Madrid', 'Barcelona', 'Valencia', 'Seville', 'Malaga', 'Bilbao',
  'Granada', 'Ibiza',
  'Lisbon', 'Porto',

  // Northern Europe
  'Stockholm', 'Gothenburg', 'Oslo', 'Bergen', 'Copenhagen', 'Helsinki',
  'Reykjavik', 'Tallinn', 'Riga', 'Vilnius',

  // Eastern Europe
  'Prague', 'Warsaw', 'Krakow', 'Gdansk', 'Budapest', 'Bratislava',
  'Ljubljana', 'Zagreb', 'Belgrade', 'Sarajevo', 'Skopje', 'Tirana',
  'Sofia', 'Bucharest', 'Athens', 'Thessaloniki',
  'Istanbul', 'Ankara', 'Izmir', 'Antalya', 'Cappadocia',
  'Kiev', 'Kyiv', 'Moscow', 'St Petersburg', 'Saint Petersburg', 'Minsk',

  // Middle East
  'Dubai', 'Abu Dhabi', 'Sharjah', 'Doha', 'Riyadh', 'Jeddah', 'Mecca',
  'Medina', 'Kuwait City', 'Manama', 'Muscat', 'Tehran', 'Baghdad',
  'Beirut', 'Damascus', 'Amman', 'Jerusalem', 'Tel Aviv',

  // Africa
  'Cairo', 'Alexandria', 'Casablanca', 'Marrakech', 'Rabat', 'Fez',
  'Tunis', 'Algiers', 'Lagos', 'Abuja', 'Accra', 'Addis Ababa',
  'Nairobi', 'Mombasa', 'Kampala', 'Dar es Salaam', 'Zanzibar', 'Kigali',
  'Johannesburg', 'Cape Town', 'Durban', 'Pretoria', 'Harare', 'Lusaka',
  'Maputo', 'Gaborone', 'Windhoek', 'Mauritius', 'Port Louis',
  'Victoria Falls',

  // South Asia
  'Mumbai', 'Bombay', 'Delhi', 'New Delhi', 'Kolkata', 'Calcutta',
  'Chennai', 'Madras', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Pune',
  'Ahmedabad', 'Lucknow', 'Jaipur', 'Agra', 'Varanasi', 'Goa',
  'Chandigarh', 'Shimla', 'Manali', 'Rishikesh', 'Udaipur', 'Jodhpur',
  'Kochi', 'Amritsar', 'Darjeeling', 'Dharamshala', 'Pushkar', 'Hampi',
  'Mysore', 'Mysuru', 'Coimbatore', 'Indore', 'Bhopal', 'Nagpur',
  'Surat', 'Vadodara', 'Patna', 'Bhubaneswar', 'Visakhapatnam',
  'Kathmandu', 'Pokhara', 'Dhaka', 'Colombo', 'Kandy', 'Galle',
  'Thimphu', 'Male', 'Islamabad', 'Karachi', 'Lahore', 'Kabul',

  // Southeast Asia
  'Bangkok', 'Chiang Mai', 'Phuket', 'Krabi', 'Pattaya', 'Koh Samui',
  'Singapore', 'Kuala Lumpur', 'Penang', 'Langkawi',
  'Jakarta', 'Bali', 'Denpasar', 'Ubud', 'Surabaya', 'Yogyakarta',
  'Manila', 'Cebu', 'Boracay', 'Palawan',
  'Hanoi', 'Ho Chi Minh', 'Ho Chi Minh City', 'Saigon', 'Da Nang', 'Hoi An',
  'Phnom Penh', 'Siem Reap', 'Vientiane', 'Yangon', 'Rangoon', 'Bagan',

  // East Asia
  'Tokyo', 'Osaka', 'Kyoto', 'Yokohama', 'Sapporo', 'Fukuoka', 'Hiroshima',
  'Nagoya', 'Nara', 'Okinawa',
  'Seoul', 'Busan', 'Incheon', 'Jeju',
  'Pyongyang',
  'Beijing', 'Shanghai', 'Guangzhou', 'Shenzhen', 'Chengdu', 'Xian',
  'Hangzhou', 'Suzhou', 'Lhasa',
  'Hong Kong', 'Macau', 'Macao',
  'Taipei', 'Taichung', 'Kaohsiung',
  'Ulaanbaatar',

  // Oceania
  'Sydney', 'Melbourne', 'Brisbane', 'Gold Coast', 'Cairns', 'Perth',
  'Adelaide', 'Hobart', 'Darwin', 'Canberra',
  'Auckland', 'Wellington', 'Christchurch', 'Queenstown', 'Rotorua',
  'Suva', 'Nadi', 'Apia', 'Papeete',

  // Central Asia
  'Tashkent', 'Samarkand', 'Bukhara', 'Almaty', 'Astana', 'Bishkek',
  'Dushanbe', 'Ashgabat', 'Baku', 'Tbilisi', 'Yerevan',
];

const KNOWN_CITY_MAP = new Map();
for (const name of KNOWN_CITIES_RAW) {
  KNOWN_CITY_MAP.set(name.toLowerCase(), name);
}

const STOPLIST = new Set([
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours',
  'he', 'she', 'it', 'they', 'them', 'their',
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'so', 'if', 'when', 'while', 'because', 'though',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
  'today', 'tomorrow', 'yesterday', 'tonight', 'now', 'later', 'soon',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'morning', 'afternoon', 'evening', 'night', 'noon', 'midnight',
  'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'sorry',
  'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay',
  'food', 'restaurant', 'restaurants', 'hotel', 'hotels', 'flight', 'flights',
  'trip', 'travel', 'visit', 'visiting', 'tour', 'tourist',
  'help', 'menu', 'options', 'something', 'anything', 'everything', 'nothing',
  'home', 'work', 'office', 'place', 'places', 'time', 'day', 'days', 'week',
  'weeks', 'month', 'months', 'year', 'years', 'hour', 'hours',
  'people', 'person', 'kid', 'kids', 'child', 'children', 'family',
  'friends', 'group', 'solo', 'couple',
  'cheap', 'budget', 'expensive', 'premium', 'luxury',
  'good', 'best', 'great', 'nice', 'bad', 'awesome',
  'here', 'there', 'where', 'what', 'when', 'why', 'how', 'who',
  'around', 'near', 'nearby', 'close', 'far', 'next', 'last',
  'in', 'on', 'at', 'to', 'from', 'for', 'with', 'about',
  'open', 'closed', 'busy',
]);

const PREPOSITIONS = ['in', 'to', 'from', 'for', 'around', 'near', 'at', 'visiting'];
const TRAILING_KEYWORDS = ['travel', 'trip', 'guide', 'food', 'restaurants', 'hotels', 'attractions', 'sightseeing'];

function normalize(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function titleCase(name) {
  return name
    .split(/\s+/)
    .map((w) => w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function isStop(word) {
  return STOPLIST.has(word.toLowerCase());
}

export function lookupKnownCity(name) {
  if (!name || typeof name !== 'string') return null;
  return KNOWN_CITY_MAP.get(normalize(name)) || null;
}

export function isKnownCity(name) {
  return lookupKnownCity(name) !== null;
}

/**
 * Phase 1: scan text for any known-city substring (case-insensitive,
 * word-boundary-respecting). Multi-word cities checked first to avoid
 * "New York" being shadowed by "New".
 */
function scanForKnownCity(text) {
  const lower = ' ' + text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ') + ' ';

  // Sort by descending length so longest-match wins.
  const keys = Array.from(KNOWN_CITY_MAP.keys()).sort((a, b) => b.length - a.length);

  for (const key of keys) {
    const padded = ' ' + key + ' ';
    if (lower.includes(padded)) {
      return KNOWN_CITY_MAP.get(key);
    }
  }
  return null;
}

/**
 * Phase 2: preposition-led extraction. "flying to Reykjavik next week" → "Reykjavik".
 * Captures up to 2 consecutive Title Case tokens following a preposition.
 */
function extractByPreposition(text) {
  const tokens = text.split(/(\s+|[,.!?;:])/);
  const cleaned = tokens.filter((t) => t && !/^\s+$/.test(t));

  for (let i = 0; i < cleaned.length - 1; i++) {
    const prep = cleaned[i].toLowerCase();
    if (!PREPOSITIONS.includes(prep)) continue;

    const next = cleaned[i + 1];
    if (!next || /^[,.!?;:]$/.test(next)) continue;

    if (!isCapitalized(next)) continue;
    if (isStop(next)) continue;

    let phrase = next;

    // Try to extend with one more capitalized token (handles "New York", "Cape Town")
    const after = cleaned[i + 2];
    if (after && isCapitalized(after) && !isStop(after) && !/^[,.!?;:]$/.test(after)) {
      phrase = `${next} ${after}`;
    }

    if (phrase.length < 2) continue;
    if (isStop(phrase)) continue;

    const known = lookupKnownCity(phrase);
    if (known) return known;

    // If first 2-token didn't resolve to known but single-token does, prefer single
    const singleKnown = lookupKnownCity(next);
    if (singleKnown) return singleKnown;

    // Unknown city: return as-is in Title Case (this is the value-add over the regex)
    return titleCase(phrase);
  }
  return null;
}

/**
 * Phase 3: trailing-keyword extraction. "Florence food", "Lisbon hotels".
 */
function extractByTrailingKeyword(text) {
  const tokens = text.split(/(\s+|[,.!?;:])/).filter((t) => t && !/^\s+$/.test(t));

  for (let i = 1; i < tokens.length; i++) {
    const word = tokens[i].toLowerCase();
    if (!TRAILING_KEYWORDS.includes(word)) continue;

    const prev = tokens[i - 1];
    if (!prev || /^[,.!?;:]$/.test(prev)) continue;
    if (!isCapitalized(prev)) continue;
    if (isStop(prev)) continue;

    let phrase = prev;
    const beforePrev = tokens[i - 2];
    if (beforePrev && isCapitalized(beforePrev) && !isStop(beforePrev) && !/^[,.!?;:]$/.test(beforePrev)) {
      phrase = `${beforePrev} ${prev}`;
    }

    const known = lookupKnownCity(phrase) || lookupKnownCity(prev);
    if (known) return known;

    if (phrase.length >= 2) return titleCase(phrase);
  }
  return null;
}

function isCapitalized(token) {
  if (!token || token.length < 2) return false;
  const first = token[0];
  return first >= 'A' && first <= 'Z';
}

export function extractCity(text) {
  if (!text || typeof text !== 'string') return null;

  const phase1 = scanForKnownCity(text);
  if (phase1) return phase1;

  const phase2 = extractByPreposition(text);
  if (phase2) return phase2;

  const phase3 = extractByTrailingKeyword(text);
  if (phase3) return phase3;

  return null;
}

export default {
  extractCity,
  lookupKnownCity,
  isKnownCity,
};

// Inline self-tests: `node src/util/cityExtractor.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0;
  let fail = 0;
  const t = (name, actual, expected) => {
    const ok = actual === expected;
    if (ok) { pass++; console.log(`PASS  ${name}`); }
    else { fail++; console.log(`FAIL  ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  };

  t('known lowercase: paris', extractCity('best food in paris'), 'Paris');
  t('known mid-sentence: Tokyo', extractCity("I'm in Tokyo for work"), 'Tokyo');
  t('multi-word: New York', extractCity('flights to New York'), 'New York');
  t('multi-word: Hong Kong', extractCity('layover in Hong Kong'), 'Hong Kong');
  t('preposition unknown: Reykjavik', extractCity('visiting Reykjavik next week'), 'Reykjavik');
  t('trailing keyword: Florence', extractCity('Florence food recommendations'), 'Florence');
  t('stoplist rejection: Today', extractCity('I want to go Today'), null);
  t('no city: empty', extractCity("what's good to eat"), null);
  t('case: HONG KONG', extractCity('best dim sum in HONG KONG'), 'Hong Kong');
  t('lookup case-insensitive', lookupKnownCity('TOKYO'), 'Tokyo');
  t('lookup unknown', lookupKnownCity('Atlantis'), null);
  t('isKnownCity true', isKnownCity('paris'), true);
  t('isKnownCity false', isKnownCity('Atlantis'), false);
  t('preposition city in middle: from Lisbon', extractCity('flights from Lisbon to Rome'), 'Lisbon');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
