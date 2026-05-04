/**
 * Parses prior bot responses into a list of options, and detects when the user's
 * follow-up message refers to one of those options by ordinal.
 *
 * Replaces the brittle helpers in src/index.js (extractOrdinalReference,
 * getOptionDetailsFromLastResponse) which only matched numbered lines and
 * therefore never matched the actual *bold-name* format Gemini emits.
 */

const ORDINAL_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
  '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10,
};

const ORDINAL_TOKEN_PATTERN = '(?:one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|\\d{1,2})';
const ITEM_NOUN_PATTERN = '(?:option|choice|item|recommendation|suggestion|result|number|no\\.?|place|spot|pick|one)';

const NUMBERED_LINE_RE = /^\s*(\d{1,2})[\.\)\-:]\s+(.+)$/;
const BOLD_LINE_RE = /^\s*\*([^\*\n]{1,80})\*\s*(.*)$/;
const BULLET_LINE_RE = /^\s*[\*\-•]\s+(.+)$/;

function tokenToNumber(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  const numeric = parseInt(lower, 10);
  if (!isNaN(numeric) && numeric >= 1 && numeric <= 20) return numeric;
  return ORDINAL_WORDS[lower] || null;
}

/**
 * Split a string into items by detecting markers (numbered, *bold*, bullets).
 * Returns Array<{ index, title, body }> with parser-assigned 1-based index.
 */
export function parseOptions(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/);
  const items = [];
  let current = null;

  // Decide whether to use bold-line or bullet-line as item delimiters based on
  // the first match we see. Numbered always wins; bold beats bullet.
  let mode = null;

  // First pass: detect dominant mode
  for (const line of lines) {
    if (NUMBERED_LINE_RE.test(line)) { mode = 'numbered'; break; }
  }
  if (!mode) {
    for (const line of lines) {
      if (looksLikeBoldTitleLine(line)) { mode = 'bold'; break; }
    }
  }
  if (!mode) {
    for (const line of lines) {
      if (BULLET_LINE_RE.test(line)) { mode = 'bullet'; break; }
    }
  }

  if (!mode) return [];

  for (const rawLine of lines) {
    const line = rawLine;

    let matched = false;
    if (mode === 'numbered') {
      const m = line.match(NUMBERED_LINE_RE);
      if (m) {
        if (current) items.push(current);
        current = {
          index: items.length + 1,
          title: m[2].trim(),
          body: m[2].trim(),
        };
        matched = true;
      }
    } else if (mode === 'bold' && looksLikeBoldTitleLine(line)) {
      const m = line.match(BOLD_LINE_RE);
      if (m) {
        if (current) items.push(current);
        const title = m[1].trim();
        const trailing = m[2].trim();
        const fullLine = trailing ? `*${title}* ${trailing}` : `*${title}*`;
        current = {
          index: items.length + 1,
          title,
          body: fullLine,
        };
        matched = true;
      }
    } else if (mode === 'bullet') {
      const m = line.match(BULLET_LINE_RE);
      if (m) {
        if (current) items.push(current);
        current = {
          index: items.length + 1,
          title: m[1].trim(),
          body: m[1].trim(),
        };
        matched = true;
      }
    }

    if (!matched && current) {
      const trimmed = line.trim();
      if (trimmed) {
        current.body += '\n' + trimmed;
      }
    }
  }

  if (current) items.push(current);

  return items;
}

/**
 * True if the line looks like a *Place Name* leading-bold title line, not
 * inline emphasis like "rated *4.5* stars".
 */
function looksLikeBoldTitleLine(line) {
  const m = line.match(BOLD_LINE_RE);
  if (!m) return false;
  const title = m[1].trim();
  // Reject things like *4.5/5* or *₹500* — bold rating/price fragments.
  if (/^\d+(\.\d+)?(\/\d+)?$/.test(title)) return false;
  if (/^[\d\.\,\₹\$\€\£\¥]+$/.test(title)) return false;
  if (title.length < 2) return false;
  return true;
}

const BARE_NUMERIC_DISQUALIFIERS = [
  'day', 'days', 'week', 'weeks', 'hour', 'hours', 'minute', 'minutes',
  'people', 'person', 'adult', 'adults', 'child', 'children', 'kid', 'kids',
  'night', 'nights', 'year', 'years', 'month', 'months',
  'rupee', 'rupees', 'dollar', 'dollars', 'euro', 'euros',
  'km', 'mile', 'miles', 'meter', 'meters',
];

/**
 * Detect whether a user message refers to a specific option by ordinal.
 * Returns the 1-based number, or null.
 *
 * Pass `lastResponseHadList: true` to enable bare-numeric matching like "3" or
 * "the 3" — without context, those are ambiguous and we refuse to match.
 */
export function extractOrdinalReference(text, opts = {}) {
  if (!text || typeof text !== 'string') return null;
  const lastResponseHadList = !!opts.lastResponseHadList;
  const original = text.trim();
  const lower = original.toLowerCase();

  // Pattern A: noun + ordinal — "option 3", "choice two", "no. 4", "the third pick"
  const reA = new RegExp(`\\b${ITEM_NOUN_PATTERN}\\s*(?:number\\s+)?${ORDINAL_TOKEN_PATTERN}\\b`, 'i');
  const matchA = lower.match(reA);
  if (matchA) {
    const tokenMatch = matchA[0].match(new RegExp(`${ORDINAL_TOKEN_PATTERN}$`, 'i'));
    if (tokenMatch) {
      const n = tokenToNumber(tokenMatch[0]);
      if (n) return n;
    }
  }

  // Pattern B: ordinal + noun — "third option", "second choice", "first pick"
  const reB = new RegExp(`\\b${ORDINAL_TOKEN_PATTERN}\\s+${ITEM_NOUN_PATTERN}\\b`, 'i');
  const matchB = lower.match(reB);
  if (matchB) {
    const tokenMatch = matchB[0].match(new RegExp(`^${ORDINAL_TOKEN_PATTERN}`, 'i'));
    if (tokenMatch) {
      const n = tokenToNumber(tokenMatch[0]);
      if (n) return n;
    }
  }

  // Pattern C: "the third", "the 3rd one", "the second one" — ordinal-word with implicit reference
  const reC = /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\b(\s+one)?/i;
  const matchC = lower.match(reC);
  if (matchC) {
    const n = tokenToNumber(matchC[1]);
    if (n) return n;
  }

  // Pattern D: "tell me about 3", "details on 2", "more on the 4th", "expand on 1"
  const reD = new RegExp(`\\b(?:tell\\s+me\\s+(?:about|more)|more\\s+(?:about|on|info)|details?\\s+(?:on|about|for)|info\\s+(?:on|about)|expand\\s+on|go\\s+deeper\\s+on|elaborate\\s+on)\\s+(?:the\\s+)?(?:${ITEM_NOUN_PATTERN}\\s+)?(${ORDINAL_TOKEN_PATTERN})\\b`, 'i');
  const matchD = lower.match(reD);
  if (matchD) {
    const n = tokenToNumber(matchD[1]);
    if (n) return n;
  }

  // Pattern E: "#3", "#2"
  const reE = /#\s*(\d{1,2})\b/;
  const matchE = lower.match(reE);
  if (matchE) {
    const n = tokenToNumber(matchE[1]);
    if (n) return n;
  }

  // Pattern F: bare numeric — only when context says the last bot response had a list,
  // message is short, and contains no disqualifier words like "days" / "people".
  if (lastResponseHadList && original.length <= 25) {
    const hasDisqualifier = BARE_NUMERIC_DISQUALIFIERS.some((word) =>
      new RegExp(`\\b${word}\\b`, 'i').test(lower)
    );
    if (!hasDisqualifier) {
      const reF = /^(?:the\s+|option\s+|choice\s+|number\s+|no\.?\s+|#)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\??\s*$/i;
      const matchF = lower.match(reF);
      if (matchF) {
        const n = tokenToNumber(matchF[1]);
        if (n) return n;
      }
    }
  }

  return null;
}

/**
 * Convenience: parse the previous response and return the body for the
 * referenced option, or null.
 */
export function findReferencedOption(previousResponse, userMessage) {
  if (!previousResponse || !userMessage) return null;
  const items = parseOptions(previousResponse);
  if (items.length === 0) return null;
  const ordinal = extractOrdinalReference(userMessage, { lastResponseHadList: true });
  if (!ordinal) return null;
  const matched = items.find((item) => item.index === ordinal);
  return matched ? matched.body.trim() : null;
}

export default {
  parseOptions,
  extractOrdinalReference,
  findReferencedOption,
};

// Inline self-tests: `node src/util/optionParser.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0;
  let fail = 0;
  const t = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log(`PASS  ${name}`); }
    else { fail++; console.log(`FAIL  ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  };

  // parseOptions — numbered
  const numbered = parseOptions('Here are options:\n1. Foo place\nGreat food\n2. Bar place\n3. Baz place');
  t('numbered: 3 items', numbered.length, 3);
  t('numbered: titles', numbered.map((i) => i.title), ['Foo place', 'Bar place', 'Baz place']);

  // parseOptions — bold
  const bold = parseOptions(`*Trishna* - Award-winning seafood
Fort, Mumbai
4.6/5

*Bademiya* - Iconic kebabs
Colaba

*Britannia* - Heritage Parsi
Closes 4 PM`);
  t('bold: 3 items', bold.length, 3);
  t('bold: titles', bold.map((i) => i.title), ['Trishna', 'Bademiya', 'Britannia']);
  t('bold: body includes follow-up lines', bold[0].body.includes('Fort, Mumbai'), true);

  // parseOptions — false-positive guard for inline bold
  const falsePos = parseOptions('rated *4.5* stars\n*Real Place* - description');
  t('false-positive: skips bold rating', falsePos.length, 1);
  t('false-positive: keeps real place', falsePos[0].title, 'Real Place');

  // parseOptions — bullet
  const bullets = parseOptions('* Foo\n* Bar\n* Baz');
  t('bullet: 3 items', bullets.length, 3);

  // extractOrdinalReference — explicit
  t('ordinal: option 3', extractOrdinalReference('tell me about option 3'), 3);
  t('ordinal: third choice', extractOrdinalReference('the third choice please'), 3);
  t('ordinal: more on the 2nd', extractOrdinalReference('more on the 2nd'), 2);
  t('ordinal: #4', extractOrdinalReference('#4 looks good'), 4);
  t('ordinal: details on 1', extractOrdinalReference('details on 1'), 1);
  t('ordinal: second one', extractOrdinalReference('the second one'), 2);

  // extractOrdinalReference — bare numeric guard
  t('bare: rejects without context', extractOrdinalReference('3', { lastResponseHadList: false }), null);
  t('bare: accepts with context', extractOrdinalReference('3', { lastResponseHadList: true }), 3);
  t('bare: rejects "I have 3 days"', extractOrdinalReference('I have 3 days', { lastResponseHadList: true }), null);
  t('bare: rejects "2 people"', extractOrdinalReference('2 people', { lastResponseHadList: true }), null);
  t('bare: accepts "the 3"', extractOrdinalReference('the 3', { lastResponseHadList: true }), 3);

  // findReferencedOption end-to-end
  const prevResp = `*Trishna* - seafood
Fort, Mumbai

*Bademiya* - kebabs
Colaba

*Britannia* - Parsi
Ballard Estate`;
  const found = findReferencedOption(prevResp, 'tell me more about option 2');
  t('e2e: finds Bademiya for option 2', found && found.includes('Bademiya'), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
