// The pilot brain: Claude writes what each crew says on the radio.
// The simulator stays the source of truth. Claude only (a) phrases what a pilot says about
// something the sim already decided, and (b) works out what a controller meant when the
// game's own phrase parser could not. Every number Claude says is checked against the sim.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.PILOT_MODEL || 'claude-haiku-5-5';

const SYSTEM = `You are every airline crew on frequency in a realistic air traffic control simulator. The human is the controller. You speak as the pilot of ONE aircraft per request, and your words are turned into speech and played over a VHF radio, so write exactly what that pilot says on the radio and nothing else.

Sound like real line pilots, not a script:
- Real radio phraseology first: readbacks of headings, altitudes, runways, frequencies, squawks, hold-short and clearances are complete and in the normal order; the callsign goes at the end of a readback (sometimes at the start).
- Then the human layer that real crews have: small fillers ("uh", "and", "okay"), contractions, "with you", "good day", "we'll", "looking", "appreciate it", a polite "thanks" on a handoff, a short laugh only if something is actually funny. Use them sparingly; busy frequencies are brief.
- Stay in character. The persona tells you who is speaking (role, temperament, where they are from, how fluent their English is, how long their day has been). A tired red-eye crew is flat and short. A chatty regional first officer is warmer. A non-native speaker uses correct phraseology but plainer, slightly formal everyday English. Never fake an accent with spelling.
- Never repeat a phrase you used in the recent exchanges for this aircraft; vary naturally.
- Stress shows in emergencies: clipped, focused, maybe a breath, but always professional.

Hard rules (the simulator depends on them):
- Write the callsign exactly as given in "callsign" (for example AAL123), once per transmission. Never spell it out.
- Write numbers as digits: headings as three digits (240, 090), altitudes as 5000 or FL240, speeds as 210, runways as 27L, frequencies as 124.35, squawks as 4721, gates as gate 7. The audio system turns them into proper radio words.
- When "must_say" is given, it is the CONTENT of the transmission, written by a robot: what the pilot understood and wants to say. Never return it word for word. Say the same content the way this particular pilot talks: reorder, trim the stiff parts, add their greeting or sign-off, a filler, a "with you", a "thanks". Real crews often drop words like "maintain" or "and" in readbacks, and say "good afternoon" or "evening" on first contact.
- Every number in must_say must appear in your words exactly, even if it differs from what the controller said (the pilot misheard; that is part of the game). Never drop, add or "fix" an instruction, and keep the callsign.
- If must_say queries or refuses an instruction ("confirm…?", "unable", "say again", "we already…"), the pilot must clearly query or refuse it and say why, using the reason given. Never read it back as accepted, never say they'll do it, and never guess what the controller meant instead.
- Only state facts that are in the context (position, altitude, fuel, souls, weather, gate, destination). If asked something the context does not answer, give a natural, non-numeric answer ("we'll check and get back to you").
- No stage directions, no quotes, no markdown, no emoji. One radio transmission, normally under 25 words.
- "delivery" is how it should sound: pick the closest single word.`;

const DELIVERY = ['neutral', 'calm', 'friendly', 'tired', 'terse', 'hurried', 'stressed', 'urgent', 'apologetic', 'amused', 'confused'];

const SAY_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Exactly what the pilot says on the radio.' },
    delivery: { type: 'string', enum: DELIVERY },
  },
  required: ['text', 'delivery'],
  additionalProperties: false,
};

const CMD_KINDS = ['clr', 'push', 'taxi', 'holdpos', 'resume', 'luaw', 'takeoff', 'land', 'goaround', 'hdg', 'alt', 'spd', 'ils', 'direct', 'contact', 'radar', 'sayalt', 'sayhdg', 'sayspd', 'ident', 'radiocheck', 'traffic', 'squawk', 'ack'];

const INTERPRET_SCHEMA = {
  type: 'object',
  properties: {
    callsign: { type: 'string', description: 'Callsign code (e.g. AAL123) of the aircraft the controller addressed, chosen from the list. Empty string if none can be identified.' },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          k: { type: 'string', enum: CMD_KINDS, description: 'clr = IFR clearance; push = pushback approved; taxi = taxi clearance (a "hold short of runway X" inside a taxi clearance is part of taxi, NOT holdpos); holdpos = only "hold position" / "stop" (stop moving now); resume = "continue taxi"; luaw = line up and wait; takeoff = cleared for takeoff; land = cleared to land; goaround; hdg; alt; spd; ils = cleared ILS approach; direct; contact = change frequency; radar = radar contact; sayalt/sayhdg/sayspd; ident; radiocheck; traffic; squawk; ack = roger/acknowledgement only' },
          h: { type: 'integer', description: 'hdg: heading 1-360, else 0' },
          dir: { type: 'string', enum: ['', 'L', 'R'] },
          alt: { type: 'integer', description: 'alt/clr: altitude in feet, else 0' },
          v: { type: 'integer', description: 'spd: knots, else 0' },
          rwy: { type: 'string', description: 'runway like 27L, else empty' },
          via: { type: 'array', items: { type: 'string' }, description: 'taxi: taxiway letters like A, B3' },
          gate: { type: 'integer', description: 'taxi to gate number, else 0' },
          fix: { type: 'string', description: 'direct: 5-letter fix, else empty' },
          to: { type: 'string', enum: ['', 'DEL', 'GND', 'TWR', 'APP', 'CTR'] },
          code: { type: 'string', description: 'squawk/clr: 4-digit code, else empty' },
        },
        required: ['k', 'h', 'dir', 'alt', 'v', 'rwy', 'via', 'gate', 'fix', 'to', 'code'],
        additionalProperties: false,
      },
    },
    reply: { type: 'string', description: 'What that pilot says back, assuming every command is accepted. If there are no commands (a question, remark or greeting), the pilot\'s natural answer from the context.' },
    delivery: { type: 'string', enum: DELIVERY },
  },
  required: ['callsign', 'commands', 'reply', 'delivery'],
  additionalProperties: false,
};

const TASKS = {
  // the sim accepted/rejected the controller's instruction; say the readback
  reply: c => `The controller just said: "${c.controller}"
The pilot understood and answers with this (must_say): "${c.must_say}"
Say it the way this pilot really would: same content, their own words. If the controller also asked a question or said something the must_say does not cover, answer it briefly too.`,
  // the pilot starts a call (check in, request, report)
  call: c => `This pilot now makes this call (must_say): "${c.must_say}"${c.reminder ? '\nThey already called once and got no answer, so this is a follow-up; let a little impatience or concern show, matching the persona.' : ''}
Say it the way this pilot really would: same content, their own words, not the template's.`,
  // unsolicited, realistic chatter
  chatter: c => `Nobody is talking. This pilot keys up with something real crews say on a quiet moment in this phase of flight: ${c.idea}.
Keep it short and plausible for the context; do not request anything the sim cannot do (no route changes, no new altitudes) unless the idea says so.`,
  // the parser could not read the controller; work out who and what
  interpret: c => `The controller just transmitted (speech-to-text, may contain recognition errors and spelled-out numbers): "${c.controller}"
${c.selected ? `The controller has ${c.selected} selected on the scope.` : ''}
Work out which aircraft was addressed and every instruction given, using standard ATC meaning. "Expect" is not an instruction.
Report exactly what the controller said, even when it is wrong for that aircraft: a takeoff clearance given to an aircraft on final is k "takeoff", not "land"; a heading given to an aircraft at the gate is still "hdg". Never correct or improve the controller's instruction; the simulator decides whether it fits, and the pilot will query it if it doesn't.
Speech recognition often garbles airline names (Lufthansa can arrive as "left hansa" or "loved hansa", Speedbird as "speed bird"); match those to the callsign that sounds closest, using the flight number too. If two aircraft are equally plausible, return an empty callsign rather than guess.
Then write that pilot's reply, assuming every instruction fits.`,
};

// Two ways to reach Claude: an API key, or Claude Code with your own login (PILOT_BACKEND=cli).
const BACKEND = (process.env.PILOT_BACKEND || (process.env.ANTHROPIC_API_KEY ? 'api' : 'cli')).toLowerCase();
const client = BACKEND === 'api' && process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 9000, maxRetries: 1 }) : null;

// Claude Code keeps one conversation per process, so it gets one schema covering every task,
// and is told that each message is a separate moment on the frequency.
const CLI_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'What the pilot says on the radio (for interpret: the reply).' },
    delivery: { type: 'string', enum: DELIVERY },
    callsign: { type: 'string', description: 'interpret only: the addressed callsign, else empty' },
    commands: { ...INTERPRET_SCHEMA.properties.commands, description: 'interpret only: the instructions given, else empty' },
  },
  required: ['text', 'delivery', 'callsign', 'commands'],
  additionalProperties: false,
};
const CLI_SYSTEM = SYSTEM + `

Each message you receive is a separate, self-contained request about one moment on the frequency. Earlier messages in this conversation are other aircraft and other moments: ignore them and use only the current message's context. Answer only through the structured output. For every task except "interpret", set callsign to "" and commands to [].`;

let pool = null, cliExe = null;
if (BACKEND === 'cli' && !process.argv.includes('--mock')) {
  const { findClaude, ClaudePool } = await import('./cli.mjs');
  cliExe = findClaude();
  if (cliExe) pool = new ClaudePool({ exe: cliExe, model: MODEL, system: CLI_SYSTEM, schema: CLI_SCHEMA, size: +process.env.CLI_POOL || 2 });
}

export const brainReady = () => !!client || (!!pool && !pool.authFailed && pool.workers.length > 0);
export const brainModel = MODEL;
export const brainBackend = () => (client ? 'api' : pool ? 'cli' : 'none');
export const brainProblem = () => (pool && pool.authFailed ? 'Claude Code is not logged in: run `claude` once in a terminal and log in' : BACKEND === 'cli' && !cliExe ? 'Claude Code (`claude`) was not found on this PC' : '');
export const stopBrain = () => pool && pool.stop();

const NUM = /\d+(?:\.\d+)?/g;
const nums = s => (String(s).match(NUM) || []).map(n => n.replace(/^0+(?=\d)/, ''));

// Claude's words must keep every number the sim needs, and may only use numbers it was given.
function vet(text, ctx, heard = '') {
  if (!text || text.length > 400) return 'empty or too long';
  if (/[*_#`<>{}\[\]]/.test(text)) return 'markup';
  const said = nums(text);
  if (ctx.must_say) for (const n of nums(ctx.must_say)) if (!said.includes(n)) return `dropped ${n}`;
  const allowed = new Set(nums(JSON.stringify(ctx) + ' ' + heard));
  for (const n of said) if (!allowed.has(n) && +n > 10) return `invented ${n}`;
  if (ctx.callsign && ctx.must_say && ctx.must_say.includes(ctx.callsign) && !text.includes(ctx.callsign)) return 'no callsign';
  // a query must stay a query, and an accepted instruction must not turn into a refusal
  const NO = /\b(unable|negative|confirm|say again|not able|can'?t|cannot|already|need|we're not|we are not)\b/i;
  if (ctx.must_say && NO.test(ctx.must_say) && !NO.test(text)) return 'lost the query';
  if (ctx.must_say && !NO.test(ctx.must_say) && /\b(unable|negative)\b/i.test(text)) return 'invented a refusal';
  return '';
}

async function ask(task, ctx, schema) {
  if (!client) {
    const prompt = `Task: ${task}\n${TASKS[task](ctx)}\n\nContext:\n${JSON.stringify(ctx.context || {}, null, 1)}`;
    const { out, usage } = await pool.ask(prompt);
    if (task === 'interpret') return { out: { callsign: out.callsign || '', commands: out.commands || [], reply: out.text || '', delivery: out.delivery }, usage };
    return { out: { text: out.text, delivery: out.delivery }, usage };
  }
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${TASKS[task](ctx)}\n\nContext:\n${JSON.stringify(ctx.context || {}, null, 1)}` }],
  });
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error('stop: ' + msg.stop_reason);
  const block = msg.content.find(b => b.type === 'text');
  return { out: JSON.parse(block.text), usage: msg.usage };
}

// Pilots sometimes write their callsign the way it's spoken ("Lufthansa six seven two");
// the game needs the code (DLH672) so it can voice it properly and check the readback.
const WORDS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };
function fixCallsign(text, cs, airline, saidAs) {
  if (!text || !cs) return text;
  const num = (cs.match(/\d+$/) || [''])[0];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (saidAs) text = text.replace(new RegExp(esc(saidAs).replace(/\s+/g, '[\\s-]+'), 'gi'), cs);
  if (airline && num) {
    const word = Object.keys(WORDS).join('|');
    text = text.replace(new RegExp(`\\b${esc(airline)}\\s+((?:\\d|(?:${word})\\b[\\s-]*)+)(\\s+(?:heavy|super))?`, 'gi'), (m, digits) => {
      const d = digits.trim().toLowerCase().split(/[\s-]+/).map(w => WORDS[w] ?? w).join('');
      return d === num ? cs : m;
    });
  }
  // a pilot says their callsign once: keep the last (readbacks end with it), drop earlier repeats
  while (text.split(cs).length > 2) text = text.replace(new RegExp(esc(cs) + '[,.]?\\s*'), '');
  text = text.replace(/\s+,/g, ',').replace(/^[\s,]+/, '').replace(/\s{2,}/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// Pilots sometimes spell altitudes out ("eleven thousand", "flight level two four zero"); the checks need digits
const N1 = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
function digitsOf(text) {
  const W = Object.keys(N1).join('|');
  return text
    .replace(new RegExp(`\\b(${W})\\s+thousand(?:\\s+(?:and\\s+)?(${W})\\s+hundred)?\\b`, 'gi'), (m, a, b) => String(N1[a.toLowerCase()] * 1000 + (b ? N1[b.toLowerCase()] * 100 : 0)))
    .replace(new RegExp(`\\bflight level\\s+((?:(?:${W})\\b\\s*){3})`, 'gi'), (m, d) => 'FL' + d.trim().split(/\s+/).map(w => N1[w.toLowerCase()]).join('') + ' ');
}

export async function think(task, ctx) {
  if (!TASKS[task]) throw new Error('unknown task');
  if (task === 'interpret') {
    const { out, usage } = await ask(task, ctx, INTERPRET_SCHEMA);
    const hit = (ctx.context?.aircraft_on_your_frequencies || []).find(a => a.callsign === out.callsign);
    out.reply = fixCallsign(digitsOf((out.reply || '').trim()), out.callsign, hit && hit.said_as.split(' ')[0], hit && hit.said_as);
    const why = out.reply ? vet(out.reply, { ...ctx, must_say: '' }, JSON.stringify(out.commands || [])) : 'no reply';
    if (why) out.reply = '';
    return { ...out, usage, ...(why ? { rejected: why + ' (interpret)' } : {}) };
  }
  const { out, usage } = await ask(task, ctx, SAY_SCHEMA);
  const text = fixCallsign(digitsOf((out.text || '').trim()), ctx.callsign, ctx.context?.airline, ctx.context?.said_as);
  const why = vet(text, ctx);
  return why ? { text: '', rejected: why, usage } : { text, delivery: out.delivery, usage };
}

// Stand-in for testing the whole pipeline with no API key and no cost.
export function mockThink(task, ctx) {
  const m = ctx.must_say || '';
  if (task === 'interpret') {
    const said = (ctx.controller || '').toLowerCase(), list = ctx.context?.aircraft_on_your_frequencies || [];
    const ac = list.find(a => said.includes(a.said_as.split(' ')[0].toLowerCase()));
    if (!ac) return { callsign: '', commands: [], reply: '', delivery: 'neutral' };
    const blank = { h: 0, dir: '', alt: 0, v: 0, rwy: '', via: [], gate: 0, fix: '', to: '', code: '' };
    const sq = (said.match(/\b([0-7]{4})\b/) || [])[1] || '';
    if (/good to go|cleared/.test(said)) return { callsign: ac.callsign, commands: [{ ...blank, k: 'clr', alt: /five grand|5000/.test(said) ? 5000 : 0, code: sq }], reply: `Cleared as filed, up to 5000, squawk ${sq}, ${ac.callsign}, thanks.`, delivery: 'friendly' };
    return { callsign: ac.callsign, commands: [], reply: `Uh, we'll check on that and get back to you, ${ac.callsign}.`, delivery: 'neutral' };
  }
  if (task === 'chatter') return { text: `${ctx.callsign}, uh, smooth ride at this altitude if anyone's asking.`, delivery: 'friendly' };
  const body = m.replace(/\.$/, '');
  return { text: task === 'call' ? body + '.' : `${body.startsWith('Say') ? '' : 'Okay, '}${body}.`, delivery: 'calm' };
}
