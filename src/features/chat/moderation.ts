import { readModerationText, squeeze, type ModerationText } from "./moderationText.ts";
import type { ModerationCategory } from "./moderationNotice.ts";

export { blockedNotice, isModerationCategory, type ModerationCategory } from "./moderationNotice.ts";

export interface ModerationVerdict {
  allowed: boolean;
  category?: ModerationCategory;
  strikes: number;
}

interface ModerationSuspect {
  category: ModerationCategory;
  strikes: number;
}

export interface ModerationReading {
  verdict: ModerationVerdict;
  suspect?: ModerationSuspect;
  playful: boolean;
  hyperbole: boolean;
  selfHarmIntent: boolean;
  disputedHate: boolean;
  screen: boolean;
}

interface RuleHit extends ModerationSuspect {
  suspect?: boolean;
}

const ALLOWED: ModerationVerdict = { allowed: true, strikes: 0 };

function blocked(category: ModerationCategory, strikes: number): RuleHit {
  return { category, strikes };
}

function suspected(category: ModerationCategory, strikes: number): RuleHit {
  return { category, strikes, suspect: true };
}

function stemPattern(stem: string): string {
  return stem.replace(/([a-z])\1*/g, (run, letter: string) =>
    run.length > 1 ? `${letter}{${run.length},}` : `${letter}+`,
  );
}

const SLUR_SUFFIX = "(?:s|z|es|ed|ah|az)?";

const WORD_SLURS = [
  "nigger", "nigga", "niga", "nigguh", "niggah", "nigr", "nibba", "nibber", "niglet", "nigglet", "nignog", "faggot", "fag",
  "fagot", "faggit", "fgt", "dyke", "tranny", "trannie", "troon", "retard", "tard", "chink", "gook", "spic", "spick",
  "kike", "kyke", "wetback", "beaner", "coon", "raghead", "towelhead", "paki", "shemale", "jigaboo", "zipperhead",
  "golliwog", "chinaman", "sandnigger", "negroid", "gyppo", "wop", "dago", "jap", "darkie", "darky", "pickaninny",
  "dothead", "slanteye", "mongoloid", "kneegrow",
];

const EMBEDDED_SLURS = [
  "nigger", "nigga", "faggot", "tranny", "wetback", "raghead", "towelhead", "jigaboo", "zipperhead",
];

const REVERSED_SLURS = ["nigger", "faggot", "tranny"].map((slur) => [...slur].reverse().join(""));

const WORD_SLUR = new RegExp(`^(?:${WORD_SLURS.map(stemPattern).join("|")})${SLUR_SUFFIX}$`);
const EMBEDDED_SLUR = new RegExp(EMBEDDED_SLURS.map(stemPattern).join("|"));
const SPLIT_SLUR = new RegExp(`^(?:${EMBEDDED_SLURS.map(stemPattern).join("|")})${SLUR_SUFFIX}$`);
const REVERSED_SLUR = new RegExp(`^(?:${REVERSED_SLURS.map(stemPattern).join("|")})$`);
const EMBEDDED_EXCEPTIONS = /^sniggers?$|^snigger(?:ed|ing)$/;
const INSERTION_SLURS = ["nigger", "nigga", "faggot", "wetback", "raghead", "towelhead", "jigaboo", "zipperhead"].map(squeeze);

function hasInsertedSlur(token: string): boolean {
  if (EMBEDDED_EXCEPTIONS.test(token)) return false;
  const words = [...new Set([squeeze(token), squeeze(token.replace(/(?:es|ed|ah|az|s|z)$/, ""))])];
  return words.some((word) => INSERTION_SLURS.some((slur) => {
    if (word.length !== slur.length + 1) return false;
    for (let index = 1; index < word.length - 1; index += 1) {
      if (word.slice(0, index) + word.slice(index + 1) === slur) return true;
    }
    return false;
  }));
}

function phrase(words: string): string {
  return words
    .split(" ")
    .map((word) => squeeze(word).replace(/[^a-z]/g, ""))
    .join(" ");
}

function alt(list: string[]): string {
  return `(?:${list.map(phrase).join("|")})`;
}

function phrases(list: string[]): RegExp {
  return new RegExp(` ${alt(list)} `);
}

function finder(list: string[]): RegExp {
  return new RegExp(`(?<= )${alt(list)}(?= )`, "g");
}

function compactList(list: string[]): string[] {
  return list.map((words) => phrase(words).replace(/ /g, ""));
}

function squeezedSet(list: string[]): Set<string> {
  return new Set(list.map(phrase));
}

const SLUR_PHRASES = phrases([
  "porch monkey", "jungle bunny", "sand monkey", "dune coon", "yellow monkey", "knee grow", "camel jockey", "ching chong",
  "slant eye", "slant eyes", "nig nog",
]);

const GAP = (max: number) => `(?:[a-z]+ ){0,${max}}`;
const AFFIRMING_GAP = (max: number) => `(?:(?!not |never |dont |arent |isnt |aint |wont |wouldnt )[a-z]+ ){0,${max}}`;

const NEGATIONS = squeezedSet([
  "dont", "not", "never", "shouldnt", "wouldnt", "wont", "cant", "didnt", "doesnt", "isnt", "arent", "aint", "no", "nobody",
]);
const FIRST_PERSON = squeezedSet(["i", "im", "ima", "imma", "ill", "ive", "id", "me", "myself", "lemme", "lets", "we"]);
const SECOND_PERSON = squeezedSet(["you", "u", "ya", "ur", "your", "youre", "yourself", "urself", "yall"]);
const REPORTED = new RegExp(
  `(?:^| )${alt(["told me to", "tell me to", "tells me to", "telling me to", "said i should", "says i should", "wants me to", "called me", "calling me"])}$`,
);

function wordsBefore(plain: string, index: number, count: number): string[] {
  return plain.slice(0, index).trim().split(" ").filter(Boolean).slice(-count);
}

function negated(plain: string, index: number): boolean {
  return wordsBefore(plain, index, 3).some((word) => NEGATIONS.has(word));
}

function affirmed(pattern: RegExp, plain: string): boolean {
  return [...plain.matchAll(new RegExp(pattern.source, "g"))].some((match) => !negated(plain, match.index + 1));
}

function compactHas(text: ModerationText, needles: string[]): boolean {
  for (const needle of needles) {
    let at = text.compact.indexOf(needle);
    while (at >= 0) {
      if (text.wordEdges.has(at) && text.wordEdges.has(at + needle.length)) return true;
      at = text.compact.indexOf(needle, at + 1);
    }
  }
  return false;
}

const INTENT = alt([
  "ill", "i will", "we will", "i shall", "ima", "imma", "im gonna", "im going to", "i am going to", "i am gonna",
  "were going to", "we are going to", "we gonna", "gonna", "finna", "bout to", "about to", "i wanna", "i want to",
  "im about to", "im finna", "i will personally", "lemme", "let me", "i swear i will", "i swear ill",
]);
const VIOLENCE = alt([
  "kill", "murder", "shoot", "stab", "hurt", "strangle", "choke", "rape", "behead", "lynch", "bomb", "swat", "torture",
  "slit", "decapitate", "kidnap", "stalk", "beat the shit out of", "break your neck", "snap your neck", "hunt down",
  "track down", "burn down", "burn it down", "bash in", "beat to death", "beat up", "beat the crap out of",
  "beat the hell out of",
]);
const HARMLESS_OBJECTS = squeezedSet([
  "feelings", "ego", "chances", "rank", "kd", "score", "stats", "record", "streak", "team", "base", "build", "time", "vibe",
  "page", "profile", "account", "insta", "socials", "posts", "channel", "pfp",
]);
const HARMLESS_SENDS = squeezedSet(["dm", "message", "msg", "text", "email", "link", "invite", "pic", "photo", "call"]);
const DOX = alt(["dox", "doxx", "leak", "expose"]);
const TARGET = alt([
  "you", "u", "ya", "yu", "your", "ur", "him", "her", "them", "yall", "everyone", "everybody", "all of you",
]);
const GAMING = phrases([
  "game", "games", "match", "round", "lobby", "pvp", "fortnite", "minecraft", "roblox", "valorant", "ranked", "ivi",
  "spawn", "server", "boss", "level", "smash", "chess", "among us", "warzone", "cod", "apex", "overwatch", "league",
  "rivals", "the next round", "bedwars", "skywars", "duel", "duels", "raid", "dungeon", "npc", "mob", "mobs", "respawn",
  "tennis", "basketball", "football", "soccer", "baseball", "volleyball", "badminton", "ping pong",
]);
const FICTION = phrases([
  "episode", "episodes", "season", "chapter", "arc", "anime", "manga", "manhwa", "webtoon", "show", "movie", "film", "series",
  "character", "villain", "finale", "book", "plot", "spoil", "spoils", "spoiling", "spoiler", "spoilers", "isekai", "isekaid",
  "isekaied",
]);
const REAL_WORLD = phrases(["irl", "in real life", "for real", "your house", "where you live", "your family", "at school"]);
const JOKING = phrases(["lol", "lmao", "lmfao", "jk", "jking", "haha", "hahaha", "hehe", "xd", "rofl", "kidding", "joking"]);
const JOKING_SYMBOLS = /😂|🤣|💀|\/j\b|\/jk\b/u;
const HYPERBOLE = new RegExp(
  ` (?:${alt(["made me want to", "makes me want to", "made me wanna", "makes me wanna"])} die|${alt(["this", "that"])} ${alt([
    "song", "exam", "test", "quiz", "homework", "essay", "class", "lecture", "ending", "episode", "chapter", "show", "movie",
    "anime", "manga", "game", "level", "boss", "update", "lag", "meme", "video", "edit", "traffic", "weather",
  ])}) `,
);

const VIOLENT_INTENT = new RegExp(` ${INTENT} ${AFFIRMING_GAP(3)}${VIOLENCE}[a-z]* ${GAP(3)}${TARGET} `, "g");
const VIOLENT_WORD = new RegExp(` ${VIOLENCE}`);
const DOX_INTENT = new RegExp(` ${INTENT} ${AFFIRMING_GAP(2)}${DOX}[a-z]* ${GAP(2)}${TARGET} `);
const SEVERE_VIOLENCE = new RegExp(` ${alt(["rape", "behead", "lynch", "swat", "kidnap", "torture"])}`);

const SELF_HARM_WORDS = [
  "kys", "kill yourself", "kill urself", "kill your self", "kill ur self", "kill yoself", "kill yo self", "kill ya self",
  "kill yaself", "kill yourselves", "go kill yourself", "neck yourself", "neck urself", "hang yourself", "hang urself",
  "go die", "go die in a hole", "drink bleach", "end yourself", "end urself", "end your life", "end ur life",
  "unalive yourself", "unalive urself", "go unalive", "hope you kill yourself", "hope u kill yourself",
  "nobody would miss you", "no one would miss you", "nobody would care if you died", "no one would care if you died",
  "you should die", "u should die", "ur should die", "you should kill yourself", "you should kys", "u should kys",
  "just kys", "do everyone a favor and die", "do us a favor and die", "do the world a favor and die", "jump off a bridge",
  "jump off a cliff", "slit your wrists", "slit ur wrists", "go cut yourself", "go cut urself", "should cut yourself",
  "cut yourself again", "cut your wrists", "cut ur wrists", "go off yourself", "go off urself", "just off yourself",
  "just off urself",
  "rope yourself", "rope urself", "go rope", "go commit suicide", "commit suicide already", "go commit sudoku",
  "commit sudoku", "the world is better without you", "the world would be better without you", "an hero",
  "you should commit suicide", "u should commit suicide", "go overdose", "take all your pills",
];
const SELF_HARM = finder(SELF_HARM_WORDS);
const SELF_HARM_COMPACT = compactList(["kill yourself", "kill urself", "kys", "neck yourself", "hang yourself", "go die"]);

const CRISIS_WORDS = [
  "kms", "kill myself", "kill my self", "killing myself", "end my life", "ending my life", "end it all", "take my own life",
  "take my life", "i want to die", "i wanna die", "i wanted to die", "want to die", "wanna die", "i want to be dead",
  "i wish i was dead", "i wish i were dead", "i wish i wasnt alive", "i wish i was never born", "i wish i wasnt born",
  "i dont want to live", "i dont wanna live", "i dont want to be alive", "i dont wanna be alive", "dont want to exist anymore",
  "dont wanna exist anymore", "i want to disappear forever", "unalive myself", "unaliving myself", "sewer slide",
  "neck myself", "hang myself", "hanging myself", "slit my wrists", "slit my wrist", "cutting myself", "cut myself again",
  "want to cut myself", "wanna cut myself", "going to cut myself", "gonna cut myself", "cut my wrists", "cut my arms",
  "cut my thighs", "i cut again", "i self harm", "i selfharm", "im self harming", "been self harming",
  "started self harming", "shoot myself", "blow my brains out", "put a bullet in my head", "overdose on", "od on pills",
  "take all my pills", "starve myself", "i want it all to end", "i want everything to end", "no reason to live",
  "life is not worth living", "my life is not worth living", "i want to commit suicide", "i wanna commit suicide",
  "im going to commit suicide", "im gonna commit suicide", "i will commit suicide", "i tried to commit suicide",
  "i might commit suicide", "i should commit suicide", "i attempted suicide", "my suicide", "my suicide note",
  "writing a suicide note", "relapsed on sh", "better off without me", "nobody would miss me", "no one would miss me",
  "nobody would care if i died", "no one would care if i died", "nobody would notice if i was gone",
  "took a bunch of pills", "took all the pills", "took too many pills", "swallowed a bunch of pills", "done with life",
  "tired of life", "sick of living", "tired of living", "done living", "tired of being alive",
];
const ENDING_IT = finder(["tonight is the night", "i end it", "gonna end it", "going to end it", "want to end it", "wanna end it"]);
const CRISIS = finder(CRISIS_WORDS);
const CRISIS_COMPACT = compactList(["kill myself", "kms", "end my life", "unalive myself"]);
const SUICIDAL = new RegExp(
  ` ${alt(["im", "i am", "i feel", "i felt", "i get", "ive been", "i was", "feeling", "been", "so", "really", "very", "kinda", "lowkey", "getting"])} ${GAP(1)}suicidal `,
);
const SUICIDAL_THOUGHTS = phrases(["suicidal thoughts", "suicidal again", "i have suicidal", "suicidal ideation"]);
const SEEKING_METHODS = phrases([
  "how to kill yourself", "how to kill myself", "how do i kill myself", "how can i kill myself", "best way to kill yourself",
  "best way to kill myself", "best way to die", "painless way to die", "painless suicide", "easiest way to die",
  "how to overdose", "how deep to cut", "how to cut yourself", "how to cut myself",
  "suicide method", "suicide methods", "ways to commit suicide", "how to commit suicide", "how to hang yourself",
  "how to hang myself", "how to slit", "what pills can kill",
]);
const DOSAGE_QUESTION = phrases(["how many pills", "how much tylenol"]);
const DOSAGE_HARM = phrases(["to die", "to kill", "to overdose", "fatal", "lethal"]);
const SELF_HARM_INTENT = new RegExp(` ${alt([
  "i will", "ill", "im going to", "i am going to", "im gonna", "i am gonna", "i want to", "i wanna", "i might", "i plan to",
  "im planning to", "i am planning to", "im about to", "i am about to", "i need to", "i should", "im ready to", "i am ready to",
])} ${AFFIRMING_GAP(2)}${alt([
  "jump", "hurt myself", "harm myself", "kill myself", "end my life", "die", "overdose", "cut myself", "hang myself",
  "shoot myself", "poison myself", "step in front", "walk into traffic", "starve myself", "take all my pills", "end it",
])} `, "g");
const RECOVERY = phrases(["got help", "doing better", "in recovery", "recovering"]);
const PAST_ATTEMPT = new RegExp(` ${alt(["used to", "tried to", "attempted to"])} $`);
const KILOMETERS = /\d\s*kms\b/;

const WATCH_YOUR_BACK = new RegExp(`^ ${alt(["watch your back", "watch ur back"])}(?: ${alt(["tomorrow", "tonight"])})? $`);
const THREATS = phrases([
  "i know where you live", "i know where u live", "i know where you go to school", "sleep with one eye open",
  "your family is next", "i will leak your nudes", "ill leak your nudes", "ill leak your pics", "i will leak your pics",
  "ill post your nudes", "i have your nudes", "ill send your nudes", "i will send your nudes", "ill burn your house",
  "i will burn your house", "beat you to death", "beat u to death", "stab you to death", "choke you to death",
  "kill you slowly",
]);
const LOCATING = phrases([
  "i will find you", "ill find you", "im coming for you", "hunt you down", "hunt u down", "track you down", "track u down",
  "find your house", "come to your house", "coming to your house", "show up at your house", "show up at your school",
]);
const DOOM = phrases([
  "you are going to die", "youre going to die", "ur going to die", "you will die", "you gonna die", "ill make you suffer",
  "i will make you suffer",
]);
const EXTORTION = new RegExp(
  ` send ${GAP(2)}${alt(["nudes", "noods", "pics", "pictures", "money", "robux", "vbucks", "nitro"])} ${GAP(2)}or ${GAP(2)}${alt([
    "ill", "i will", "im gonna", "im going to", "i am going to", "else",
  ])} ${GAP(2)}`,
);

const PLACES = alt([
  "school", "church", "mosque", "synagogue", "temple", "mall", "office", "building", "class", "concert", "hospital", "airport",
]);
const MASS_VIOLENCE = new RegExp(
  ` (?:${alt(["shoot up", "blow up", "bomb", "shoot"])} ${alt(["the", "a", "this", "that", "my", "our", "your", "ur"])}|${alt([
    "bring", "bringing", "brought", "take", "taking",
  ])} ${GAP(1)}${alt(["gun", "guns", "rifle", "bomb", "weapon", "weapons"])} to(?: [a-z]+)?) ${PLACES} `,
);

const HARM_TARGET = alt(
  ["family", "mom", "mother", "dad", "father", "kids", "sister", "brother", "parents", "whole family", "dog", "cat"]
    .flatMap((relative) => [`your ${relative}`, `ur ${relative}`])
    .concat(["you", "u", "he", "she", "they", "him", "her", "them"]),
);
const HARM = alt([
  "die", "dies", "died", "dead", "get cancer", "gets cancer", "get raped", "gets raped", "get shot", "gets shot",
  "get hit by", "gets hit by", "get run over", "burn", "burns", "suffer", "suffers", "get killed", "gets killed",
  "get murdered", "gets murdered", "starve", "choke", "drown", "overdose", "get aids", "get stabbed", "gets stabbed",
  "get beaten", "get tortured", "rot",
]);
const DEATH_WISH = new RegExp(` ${alt(["hope", "wish", "pray", "hoping", "praying"])} ${GAP(1)}${HARM_TARGET} ${AFFIRMING_GAP(2)}${HARM} `, "g");
const HARASSMENT = phrases([
  "you deserve to die", "u deserve to die", "you deserve to be raped", "you deserve to get raped",
  "deserve to be raped", "deserve to get raped", "should get raped", "should be raped", "go get raped",
  "should have been aborted", "shouldve been aborted", "should of been aborted", "should have aborted you",
  "shouldve aborted you", "should of aborted you", "should have swallowed you", "shouldve swallowed you",
  "you should be shot", "u should be shot", "someone should shoot you", "someone should kill you",
  "someone needs to kill you", "somebody should kill you", "you deserve to be shot", "you need to be put down",
  "your family should die", "your mom should die", "i hope your whole family dies", "i will ruin your life",
  "ill ruin your life", "im going to ruin your life", "i will make your life hell", "ill make your life hell",
]);
const HARASS_CALL = new RegExp(
  ` ${alt(["lets", "lets all", "everyone", "everybody", "yall", "guys", "we should", "go", "we need to"])} ${GAP(1)}${alt([
    "harass", "bully", "cyberbully", "dogpile", "torment", "mass report", "brigade",
  ])} ${alt(["him", "her", "them", "this guy", "this girl", "that guy", "that girl", "this kid", "that kid"])} `,
);

const GROUPS = alt([
  "jews", "jew", "muslims", "blacks", "black people", "gays", "gay people", "lesbians", "trans people", "trannies",
  "immigrants", "refugees", "mexicans", "asians", "chinese", "arabs", "indians", "latinos", "women", "christians", "hindus",
  "disabled people", "africans", "white people", "whites", "natives", "sikhs", "jewish people", "migrants", "foreigners",
  "gypsies", "roma", "queers", "transgenders", "homosexuals", "trans women", "trans men", "autistic people", "bisexuals",
]);
const GROUP_TRAITS = alt([
  "gay", "trans", "lesbian", "bi", "bisexual", "black", "jewish", "muslim", "asian", "mexican", "autistic", "disabled",
  "queer", "nonbinary", "transgender", "homosexual",
]);
const DEHUMANIZING = alt([
  "animals", "subhuman", "subhumans", "vermin", "parasites", "rats", "cockroaches", "roaches", "a disease", "a cancer",
  "savages", "monkeys", "apes", "a plague", "not human", "less than human", "filth", "groomers", "pedos", "pedophiles",
  "rapists", "a virus", "scum",
]);
const DEMEANING = alt([
  "inferior", "predators", "mentally ill", "a mental illness", "terrorists", "criminals", "thieves", "trash", "garbage", "evil",
  "dirty",
]);
const ERASURE = alt([
  "exterminated", "gassed", "eradicated", "wiped out", "sterilized", "put in camps", "killed", "purged",
  "lynched", "hanged", "burned", "banned from existing", "shot", "put down", "euthanized",
]);
const HATE_RULES = [
  new RegExp(` ${GROUPS} ${GAP(2)}${alt(["are", "r", "is"])} ${AFFIRMING_GAP(2)}${DEHUMANIZING} `),
  new RegExp(` ${GROUPS} ${AFFIRMING_GAP(4)}${alt(["should", "need to", "must", "deserve to"])} ${GAP(1)}${alt(["be", "get"])} ${GAP(1)}${ERASURE} `),
  new RegExp(` ${GROUPS} ${GAP(1)}${alt(["should", "need to", "must", "deserve to"])} ${alt(["die", "all die", "burn", "rot", "go extinct", "not exist"])} `),
  new RegExp(` ${GROUPS} ${alt(["dont", "do not"])} deserve ${alt(["to live", "rights", "to exist", "human rights"])} `),
  new RegExp(` being ${GROUP_TRAITS} is ${alt(["a disease", "a mental illness", "mental illness", "disgusting", "unnatural", "an abomination"])} `),
  new RegExp(` ${alt(["gas", "exterminate", "kill all", "kill every", "death to", "deport all", "genocide", "eradicate", "wipe out", "hang all", "lynch all"])} ${GAP(2)}${GROUPS} `),
  phrases([
    "heil hitler", "sieg heil", "hitler was right", "white power", "white pride world wide", "gas the jews",
    "jews will not replace us", "you will not replace us", "race war now", "fourteen words", "holocaust never happened",
    "six million wasnt enough", "go back to your country", "go back to africa", "go back to mexico", "go back to the jungle",
  ]),
];
const HATE_DEMEANING = [
  new RegExp(` ${GROUPS} ${GAP(2)}${alt(["are", "r", "is"])} ${AFFIRMING_GAP(2)}${DEMEANING} `),
  new RegExp(` ${GROUPS} ${alt(["belong in the kitchen", "shouldnt be allowed to vote", "should not be allowed to vote", "shouldnt have rights"])} `),
];
const HATE_DISLIKE = new RegExp(
  ` i ${alt(["hate", "despise", "cant stand"])} (?:${alt(["all", "every", "those", "these", "the", "fucking"])} )?${GROUPS} `,
);
const DISPUTED_HATE = new RegExp(
  `^ ${alt(["not all", "i disagree that"])} ${GROUPS} ${alt(["are", "r", "is"])} ${DEMEANING} $`,
);
const HATE_NUMBERS = /(?<!\d)(?:14\s*\/?\s*88|1488)(?!\d)/;

const SEXUAL = phrases([
  "send nudes", "send noods", "send me nudes", "send me noods", "send nude", "send me your nudes", "nudes pls",
  "nudes please", "trade nudes", "sell nudes", "selling nudes", "buy nudes", "buying nudes", "nude pics", "nude pic",
  "naked pics", "naked pic", "send pussy pics", "send dick pics", "send me dick pics", "dick pic", "dick pics", "cock pic",
  "cock pics", "tit pics", "boob pics", "show me your tits", "show me ur tits", "show me your boobs", "show me ur boobs",
  "show me your dick", "show me ur dick", "show me your pussy", "show me ur pussy", "show bobs", "wanna see my dick",
  "want to see my dick", "wanna see my cock", "rate my dick", "wanna sext", "want to sext", "sext me", "lets sext",
  "sexting", "esex", "e sex", "cyber sex", "cybersex", "wanna cyber", "want to cyber", "erp", "nsfw rp", "lewd rp",
  "dirty rp", "sex rp", "smut rp", "nsfw roleplay", "erotic roleplay", "dm me for nudes", "dm for nudes", "dm me for nsfw",
  "dm for nsfw", "nsfw dms", "add me for nudes", "my onlyfans", "check my onlyfans", "subscribe to my onlyfans",
  "onlyfans link", "porn link", "porn links", "send porn", "send hentai", "hentai link", "wanna fuck", "want to fuck me",
  "wanna fuck me", "lets fuck", "can i fuck you", "i want to fuck you", "fuck me daddy", "suck your dick", "suck ur dick",
  "suck his dick", "suck his cock", "suck your cock", "suck ur cock", "suck you off", "blowjob", "blow job", "handjob",
  "hand job", "rimjob", "titjob", "deepthroat", "creampie", "cum in", "cum on", "cum inside", "cumming", "cumshot",
  "jerk off", "jerking off", "jerked off", "jack off", "jacking off", "jerk you off", "fap to", "fapping to", "fapped to",
  "masturbate", "masturbating", "finger you", "finger her", "finger myself", "fingering", "eat you out", "eat your pussy",
  "eat ur pussy", "eat her pussy", "eat her out", "lick your pussy", "ride your dick", "ride ur dick", "ride his dick",
  "ride my dick", "ride my cock", "sit on my face", "bend you over", "spread your legs", "spread ur legs", "spread my legs",
  "make you moan", "make me moan", "moan for me", "wet pussy", "hard cock", "my dick is hard", "im hard for you",
  "wet for you", "horny for you", "im so horny for", "anal sex", "do anal", "have sex with me", "lets have sex",
  "wanna have sex", "want to have sex with", "clit", "hentai of", "porn of", "see you naked", "get naked for me",
  "take your clothes off", "take ur clothes off", "strip for me", "rubbing myself", "touching myself", "playing with myself",
]);
const SEND_BODY = new RegExp(
  ` ${alt(["send", "dm", "show", "post", "drop"])} (?:me )?${alt(["your", "ur"])} ${alt([
    "dick", "cock", "pussy", "tits", "boobs", "nudes", "noods", "body pics", "ass pics", "feet pics", "naked pics",
  ])} `,
);
const CUM = / cum (?!laude )/;
const RULE_34 = /\br(?:ule)?\s*-?\s*34\b/;
const ROLEPLAY = phrases([
  "moan", "moans", "moaning", "undress", "undresses", "grope", "gropes",
  "unzip your pants", "unzips your pants", "unzip ur pants", "unzips ur pants",
  "licks your", "licks ur", "thrust", "thrusts", "grinds on", "spank", "spanks", "bends over", "pulls down your pants",
  "pulls down ur pants", "takes off your", "takes off ur", "kisses your neck", "kisses down your", "touches your",
  "rubs your", "naked", "nude", "cums",
]);
const AMBIGUOUS_ROLEPLAY = phrases(["unzip", "unzips", "strip", "strips"]);
const ROLEPLAY_ACTION = /\*([^*]{1,80})\*/g;
const MINORS = phrases([
  "loli", "lolis", "shota", "shotas", "underage", "minor", "minors", "kid", "kids", "child", "children", "preteen",
  "preteens", "little girl", "little girls", "little boy", "little boys", "middle schooler", "middle schoolers",
  "elementary schooler",
]);
const EXPLICIT = phrases([
  "nudes", "noods", "nude", "naked", "porn", "nsfw", "sext", "sexting", "dick", "cock", "pussy", "tits", "boobs", "cum",
  "hentai", "lewd", "lewds", "erp", "horny", "sexy",
]);
const MINOR_SEXUAL = phrases([
  "lolicon", "shotacon", "jailbait", "child porn", "kiddie porn", "child pornography", "fuck a kid", "fuck a child",
  "fuck a minor", "fuck children", "fuck minors", "sex with a kid", "sex with kids", "sex with a minor", "sex with minors",
  "sex with children", "sex with a child", "rape a kid", "rape a child", "rape kids", "rape children", "molest kids",
  "molest children", "molest a kid", "molest a child",
]);
const CP_TRADE = new RegExp(
  ` ${alt(["send", "sending", "sell", "selling", "buy", "buying", "trade", "trading", "share", "sharing", "drop", "got", "have"])} ${GAP(1)}cp | cp ${alt(["link", "links", "vids", "videos", "pics", "folder", "for sale"])} `,
);
const ABUSE_CONTENT = compactList(["csam", "csem"]);
const ABUSE_PROMOTION = finder([
  "like", "love", "enjoy", "want", "need", "into", "send", "share", "sharing", "trade", "trading", "sell", "selling",
  "buy", "buying", "watch", "watching", "download", "get", "find", "have", "got", "make", "making", "collect",
]);
const ABUSE_REPORTING = phrases([
  "report", "reporting", "reported", "remove", "removing", "removed", "block", "blocking", "blocked", "illegal",
  "harmful", "wrong", "disgusting", "against", "prevent", "preventing", "stop", "stopping", "moderation", "what is",
  "what does", "means", "meaning", "stands for",
]);
const ABUSE_PREVENTION = /^(?:to |help |help to )?(?:report|remove|block|prevent|stop)(?: |$)/;
const MINOR_AGE =
  /\b(?:[1-9]|1[0-7])\s*(?:yo|y\/o|yrs? old|years? old)\b|\b(?:im|i'm|i am|shes|she's|she is|hes|he's|he is|youre|you're|you are|ur)\s+(?:only\s+|just\s+)?(?:[1-9]|1[0-7])\b(?!\s*(?:am|pm|min|mins|minutes|hours|hrs|days|weeks|%|k\b|m\b|ft|feet|inches|cm|kg|lbs|dollars|bucks|kills|wins|points|:|\.\d))/;
const SEX_EDUCATION = / sex (?:ed|education) /g;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;
const SPELLED_EMAIL = /\b[a-z0-9._-]{3,}\s*[[(]?\s*at\s*[\])]?\s*[a-z0-9-]+\s*[[(]?\s*dot\s*[\])]?\s*(?:com|net|org|edu|io|co|me)\b/;
const PHONE = /(?<![\d.])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s*|\d{3}[\s.-])\d{3}[\s.-]?\d{4}(?![\d.])/;
const BARE_PHONE = /(?<![\d.#])\+?1?\d{10}(?![\d.])/;
const PHONE_WORDS = /\b(?:call|text|phone|number|cell|digits|whatsapp|dial)\b/;
const INTERNATIONAL_PHONE = /(?<![\d.])\+\d{1,3}(?:[\s.-]?\d{2,4}){3,5}(?![\d.])/;
const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const IPV4 = /(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])/g;
const COORDINATES = /-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/;
const ADDRESS = /\b(\d{1,6})\s+((?:[a-z][a-z.'-]*\s+){1,3})(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|terrace|parkway|pkwy|highway|hwy)\b/g;
const ADDRESS_FILLERS = new Set([
  "the", "a", "an", "on", "of", "to", "for", "in", "my", "our", "your", "this", "that", "and", "more", "hours", "hour",
  "hrs", "mins", "minutes", "days", "weeks", "months", "years", "times", "people", "kills", "levels", "games", "miles",
  "km", "percent", "down", "is", "was", "at", "it", "i", "we", "you", "he", "she", "they", "per", "back", "off",
]);
const DOX_TARGET = new RegExp(
  ` ${alt(["his", "her", "their", "your", "ur", "this guys", "this girls", "that guys", "that girls"])} ${GAP(1)}${alt([
    "address", "addy", "ip", "ip address", "phone number", "location", "real name", "full name", "home address", "dox",
  ])} ${alt(["is", "are", "leaked", "here"])} `,
);
const DOX_WORDS = phrases([
  "dox him", "dox her", "dox them", "doxx him", "doxx her", "leaked his address", "leaked her address",
  "here is his address", "heres his address", "heres her address", "here is her address", "found his address",
  "found her address", "found your address", "found ur address", "got your ip", "got ur ip", "have your ip", "have ur ip",
  "i have your address", "i got your address", "i know your ip", "i know ur ip", "found out where she lives",
  "found out where he lives", "found out where they live", "found out where she goes to school",
  "found out where he goes to school",
]);
const DOX_LEAK = new RegExp(
  ` ${alt(["leak", "leaking", "expose", "exposing", "dox", "doxx"])} ${alt(["his", "her", "their", "your", "ur"])} ${alt([
    "face", "address", "addy", "school", "ip", "info", "real name", "full name", "number", "location", "pics", "photos",
  ])} `,
);
const LIVES_AT = /\blives?\s+(?:at|on)\s+\d/;

function isPrivateIp(address: string): boolean {
  const [first = 0, second = 0] = address.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254)
  );
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function hasStreetAddress(folded: string): boolean {
  for (const match of folded.matchAll(ADDRESS)) {
    const words = (match[2] ?? "").trim().split(/\s+/);
    if (!words.some((word) => ADDRESS_FILLERS.has(word))) return true;
  }
  return false;
}

function hasPersonalInfo(folded: string): boolean {
  if (EMAIL.test(folded) || SPELLED_EMAIL.test(folded)) return true;
  if (PHONE.test(folded) || INTERNATIONAL_PHONE.test(folded) || SSN.test(folded)) return true;
  if (BARE_PHONE.test(folded) && PHONE_WORDS.test(folded)) return true;
  if (COORDINATES.test(folded) || LIVES_AT.test(folded)) return true;
  for (const match of folded.matchAll(CARD)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && passesLuhn(digits)) return true;
  }
  for (const match of folded.matchAll(IPV4)) {
    if (!isPrivateIp(match[1] ?? "")) return true;
  }
  return hasStreetAddress(folded);
}

function hasSlur(text: ModerationText): boolean {
  const variants = (token: string) => [token, token.replace(/q/g, "g"), token.replace(/ph/g, "f")];
  const withoutDigits = text.folded.replace(/(?<=[a-z])[0-9]+(?=[a-z])/g, "");
  const readings = withoutDigits === text.folded ? [text] : [text, readModerationText(withoutDigits)];
  return readings.some((reading) => {
    if (reading.tokens.some((token) => variants(token).some((variant) => WORD_SLUR.test(variant) || hasInsertedSlur(variant)))) return true;
    if (reading.tokens.some((token) => REVERSED_SLUR.test(token))) return true;
    const tokens = reading.tokens.filter((token) => !EMBEDDED_EXCEPTIONS.test(token));
    if (tokens.some((token) => variants(token).some((variant) => EMBEDDED_SLUR.test(variant)))) return true;
    for (let start = 0; start < tokens.length; start += 1) {
      let joined = tokens[start] ?? "";
      for (let end = start + 1; end < tokens.length && joined.length <= 32; end += 1) {
        joined += tokens[end];
        if (variants(joined).some((variant) => SPLIT_SLUR.test(variant))) return true;
      }
    }
    return SLUR_PHRASES.test(reading.plain);
  });
}

function selfHarmHit(text: ModerationText, hyperbole: boolean): RuleHit | null {
  let matched = false;
  for (const match of text.plain.matchAll(SELF_HARM)) {
    matched = true;
    const before = wordsBefore(text.plain, match.index, 3);
    if (before.some((word) => NEGATIONS.has(word)) || REPORTED.test(before.join(" "))) continue;
    if (!before.some((word) => SECOND_PERSON.has(word)) && wordsBefore(text.plain, match.index, 5).some((word) => FIRST_PERSON.has(word))) {
      if (hyperbole || match[0] === phrase("go die")) continue;
      return blocked("crisis", 0);
    }
    return blocked("self_harm", 3);
  }
  return !matched && compactHas(text, SELF_HARM_COMPACT) ? blocked("self_harm", 3) : null;
}

function hasCrisis(text: ModerationText, hyperbole: boolean): boolean {
  if (SEEKING_METHODS.test(text.plain) || SUICIDAL_THOUGHTS.test(text.plain)) return true;
  if (DOSAGE_QUESTION.test(text.plain) && DOSAGE_HARM.test(text.plain)) return true;
  if (hyperbole) return false;
  if (SUICIDAL.test(text.plain) && !negated(text.plain, text.plain.indexOf(" suicidal ") + 1)) return true;
  let matched = false;
  for (const match of text.plain.matchAll(CRISIS)) {
    matched = true;
    if (negated(text.plain, match.index)) continue;
    if (PAST_ATTEMPT.test(text.plain.slice(0, match.index)) && RECOVERY.test(text.plain.slice(match.index + match[0].length))) continue;
    if (match[0] === "kms" && KILOMETERS.test(text.folded)) continue;
    return true;
  }
  return !matched && compactHas(text, CRISIS_COMPACT);
}

function ambiguousCrisisHit(text: ModerationText, hyperbole: boolean): RuleHit | null {
  if (hyperbole) return null;
  if (DOSAGE_QUESTION.test(text.plain)) return suspected("crisis", 0);
  for (const match of text.plain.matchAll(ENDING_IT)) {
    if (!negated(text.plain, match.index)) return suspected("crisis", 0);
  }
  return null;
}

function threatHit(text: ModerationText, playful: boolean): RuleHit | null {
  const severe = REAL_WORLD.test(text.plain);
  if (THREATS.test(text.plain) || MASS_VIOLENCE.test(text.plain) || EXTORTION.test(text.plain)) return blocked("threat", 3);
  if (WATCH_YOUR_BACK.test(text.plain) && !GAMING.test(text.plain)) return blocked("threat", 3);
  if (LOCATING.test(text.plain) && !playful) {
    return VIOLENT_WORD.test(text.plain) ? blocked("threat", 3) : suspected("threat", 3);
  }
  for (const match of text.plain.matchAll(VIOLENT_INTENT)) {
    if (negated(text.plain, match.index + 1)) continue;
    const [next = "", after = ""] = text.plain.slice(match.index + match[0].length).split(" ");
    if (HARMLESS_OBJECTS.has(next) || ((next === "a" || next === "an") && HARMLESS_SENDS.has(after))) continue;
    if (SEVERE_VIOLENCE.test(match[0]) || severe) return blocked("threat", 3);
    if (!playful) return suspected("threat", 3);
  }
  return DOOM.test(text.plain) && !playful ? suspected("threat", 3) : null;
}

function hateHit(text: ModerationText): RuleHit | null {
  if (HATE_RULES.some((rule) => rule.test(text.plain)) || HATE_NUMBERS.test(text.folded)) return blocked("hate", 3);
  if (DISPUTED_HATE.test(text.plain)) return null;
  if (HATE_DEMEANING.some((rule) => rule.test(text.plain)) || HATE_DISLIKE.test(text.plain)) return suspected("hate", 2);
  return null;
}

function harassmentHit(text: ModerationText): RuleHit | null {
  if (HARASSMENT.test(text.plain) || HARASS_CALL.test(text.plain)) return blocked("harassment", 2);
  if (GAMING.test(text.plain) || FICTION.test(text.plain)) return null;
  for (const match of text.plain.matchAll(DEATH_WISH)) {
    if (!negated(text.plain, match.index + 1)) return blocked("harassment", 2);
  }
  return null;
}

function sexualHit(text: ModerationText): RuleHit | null {
  const plain = text.plain.replace(SEX_EDUCATION, " ");
  const explicit = EXPLICIT.test(plain);
  if (compactHas(text, ABUSE_CONTENT)) {
    const mentions = [...plain.matchAll(ABUSE_PROMOTION)];
    const promotion = mentions.some((match) => {
      if (negated(plain, match.index)) return false;
      const following = plain.slice(match.index + match[0].length).trim().split(" ").slice(0, 3).join(" ");
      return !ABUSE_PREVENTION.test(following);
    });
    if (promotion || (!mentions.length && !ABUSE_REPORTING.test(plain))) return blocked("sexual", 3);
  }
  if (MINOR_SEXUAL.test(plain) || CP_TRADE.test(plain)) return blocked("sexual", 3);
  if (explicit && (MINORS.test(plain) || MINOR_AGE.test(text.folded))) return blocked("sexual", 3);
  if (affirmed(SEXUAL, plain) || affirmed(SEND_BODY, plain) || CUM.test(plain) || RULE_34.test(text.folded)) return blocked("sexual", 2);
  let ambiguous = false;
  for (const match of text.folded.matchAll(ROLEPLAY_ACTION)) {
    const action = readModerationText(match[1] ?? "").plain;
    if (ROLEPLAY.test(action)) return blocked("sexual", 2);
    ambiguous ||= AMBIGUOUS_ROLEPLAY.test(action);
  }
  return ambiguous ? suspected("sexual", 2) : null;
}

function doxHit(text: ModerationText): RuleHit | null {
  if ([DOX_TARGET, DOX_WORDS, DOX_INTENT, DOX_LEAK].some((rule) => rule.test(text.plain))) return blocked("doxxing", 3);
  return hasPersonalInfo(text.folded) ? blocked("doxxing", 1) : null;
}

export function readModeration(input: string): ModerationReading {
  const text = readModerationText(input);
  const playful = [GAMING, FICTION, JOKING].some((rule) => rule.test(text.plain)) || JOKING_SYMBOLS.test(text.folded);
  const hyperbole = playful || HYPERBOLE.test(text.plain);
  const selfHarmIntent = [...text.plain.matchAll(SELF_HARM_INTENT)].some((match) => !negated(text.plain, match.index + 1));
  const disputedHate = DISPUTED_HATE.test(text.plain);
  const reading: ModerationReading = { verdict: ALLOWED, playful, hyperbole, selfHarmIntent, disputedHate, screen: text.contentTokens.length > 0 };
  if (!text.tokens.length && !/\d/.test(text.folded)) return reading;

  const sexual = sexualHit(text);
  const rules = [
    () => (hasSlur(text) ? blocked("slur", 3) : null),
    () => (sexual?.strikes === 3 ? sexual : null),
    () => selfHarmHit(text, hyperbole),
    () => (hasCrisis(text, hyperbole) ? blocked("crisis", 0) : null),
    () => ambiguousCrisisHit(text, hyperbole),
    () => threatHit(text, playful),
    () => hateHit(text),
    () => harassmentHit(text),
    () => sexual,
    () => doxHit(text),
  ];
  for (const rule of rules) {
    const hit = rule();
    if (!hit) continue;
    if (!hit.suspect) return { ...reading, verdict: { allowed: false, category: hit.category, strikes: hit.strikes } };
    reading.suspect ??= { category: hit.category, strikes: hit.strikes };
  }
  return reading;
}

export function moderate(input: string): ModerationVerdict {
  return readModeration(input).verdict;
}
