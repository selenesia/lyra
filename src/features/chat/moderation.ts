import { moderationModel } from "./moderationModel.ts";
import {
  featureBuckets,
  readModerationText,
  squeeze,
  type ModerationText,
} from "./moderationText.ts";

export type ModerationCategory =
  | "slur"
  | "threat"
  | "self_harm"
  | "crisis"
  | "sexual"
  | "doxxing"
  | "hate"
  | "harassment"
  | "gore";

export interface ModerationVerdict {
  allowed: boolean;
  category?: ModerationCategory;
  strikes: number;
}

const CATEGORY_LABELS: Record<ModerationCategory, string> = {
  slur: "slurs",
  threat: "threats",
  self_harm: "encouraging self-harm",
  crisis: "self-harm",
  sexual: "sexual content",
  doxxing: "sharing personal info",
  hate: "hate speech",
  harassment: "harassment",
  gore: "gore or shock content",
};

export function isModerationCategory(value: unknown): value is ModerationCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORY_LABELS, value);
}

export function blockedNotice(subject: string, category: ModerationCategory, tense: "was" | "would be" = "was"): string {
  if (category === "crisis") {
    return `that ${subject} ${tense === "was" ? "was not" : "will not be"} posted. findahelpline.com can connect you with someone to talk to`;
  }
  return `that ${subject} ${tense} blocked for ${CATEGORY_LABELS[category]}`;
}

const ALLOWED: ModerationVerdict = { allowed: true, strikes: 0 };

function blocked(category: ModerationCategory, strikes: number): ModerationVerdict {
  return { allowed: false, category, strikes };
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
const REVERSED_SLUR = new RegExp(`^(?:${REVERSED_SLURS.map(stemPattern).join("|")})$`);
const EMBEDDED_EXCEPTIONS = /^sniggers?$|^snigger(?:ed|ing)$/;

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
  "track down", "burn down", "bash in", "beat to death",
]);
const HARMLESS_OBJECTS = squeezedSet([
  "feelings", "ego", "chances", "rank", "kd", "score", "stats", "record", "streak", "team", "base", "build", "time", "vibe",
]);
const HARMLESS_SENDS = squeezedSet(["dm", "message", "msg", "text", "email", "link", "invite", "pic", "photo", "call"]);
const DOX = alt(["dox", "doxx", "leak", "expose"]);
const TARGET = alt([
  "you", "u", "ya", "yu", "your", "ur", "him", "her", "them", "yall", "everyone", "everybody", "all of you",
]);
const GAMING = phrases([
  "game", "games", "match", "round", "lobby", "pvp", "fortnite", "minecraft", "roblox", "valorant", "ranked", "ivi",
  "spawn", "server", "boss", "level", "smash", "chess", "among us", "warzone", "cod", "apex", "overwatch", "league",
  "rivals", "the next round", "bedwars", "skywars", "duel", "duels",
]);
const REAL_WORLD = phrases(["irl", "in real life", "for real", "your house", "where you live", "your family", "at school"]);
const JOKING = phrases(["lol", "lmao", "lmfao", "jk", "jking", "haha", "hahaha", "hehe", "xd", "rofl", "kidding", "joking"]);
const JOKING_SYMBOLS = /😂|🤣|💀|\/j\b|\/jk\b/u;

const VIOLENT_INTENT = new RegExp(` ${INTENT} ${AFFIRMING_GAP(3)}${VIOLENCE}[a-z]* ${GAP(3)}${TARGET} `, "g");
const DOX_INTENT = new RegExp(` ${INTENT} ${AFFIRMING_GAP(2)}${DOX}[a-z]* ${GAP(2)}${TARGET} `);
const SEVERE_VIOLENCE = new RegExp(` ${alt(["rape", "behead", "lynch", "swat", "kidnap", "stalk", "torture", "bomb"])}`);

const SELF_HARM_WORDS = [
  "kys", "kill yourself", "kill urself", "kill your self", "kill ur self", "kill yoself", "kill yo self", "kill ya self",
  "kill yaself", "kill yourselves", "go kill yourself", "neck yourself", "neck urself", "hang yourself", "hang urself",
  "go die", "go die in a hole", "drink bleach", "end yourself", "end urself", "end your life", "end ur life",
  "unalive yourself", "unalive urself", "go unalive", "hope you kill yourself", "hope u kill yourself",
  "nobody would miss you", "no one would miss you", "nobody would care if you died", "no one would care if you died",
  "you should die", "u should die", "ur should die", "you should kill yourself", "you should kys", "u should kys",
  "just kys", "do everyone a favor and die", "do us a favor and die", "do the world a favor and die", "jump off a bridge",
  "jump off a cliff", "slit your wrists", "slit ur wrists", "go cut yourself", "go cut urself", "should cut yourself",
  "cut yourself again", "cut your wrists", "cut ur wrists", "off yourself", "off urself",
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
  "how many pills", "how much tylenol", "how to overdose", "how deep to cut", "how to cut yourself", "how to cut myself",
  "suicide method", "suicide methods", "ways to commit suicide", "how to commit suicide", "how to hang yourself",
  "how to hang myself", "how to slit", "what pills can kill",
]);
const KILOMETERS = /\d\s*kms\b/;

const WATCH_YOUR_BACK = phrases(["watch your back", "watch ur back"]);
const THREATS = phrases([
  "i know where you live", "i know where u live", "i know where you go to school",
  "you are going to die", "youre going to die", "ur going to die", "you will die", "you gonna die", "i will find you",
  "ill find you", "im coming for you", "sleep with one eye open", "your family is next", "ill make you suffer",
  "i will make you suffer", "i will leak your nudes", "ill leak your nudes", "ill leak your pics", "i will leak your pics",
  "ill post your nudes", "i have your nudes", "ill send your nudes", "i will send your nudes", "ill burn your house",
  "i will burn your house", "beat you to death", "beat u to death", "stab you to death", "choke you to death",
  "kill you slowly", "hunt you down", "hunt u down", "track you down", "track u down",
]);
const EXTORTION = new RegExp(
  ` send ${GAP(2)}${alt(["nudes", "noods", "pics", "pictures", "money", "robux", "vbucks", "nitro"])} ${GAP(2)}or ${GAP(2)}${alt([
    "ill", "i will", "im gonna", "im going to", "i am going to", "else",
  ])} ${GAP(2)}`,
);

const MASS_VIOLENCE = new RegExp(
  ` ${alt(["shoot up", "blow up", "bomb", "shoot"])} ${alt(["the", "a", "this", "that", "my", "our", "your", "ur"])} ${alt([
    "school", "church", "mosque", "synagogue", "temple", "mall", "office", "building", "class", "concert", "hospital", "airport",
  ])} `,
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
  "die in a fire", "you deserve to die", "u deserve to die", "you deserve to be raped", "you deserve to get raped",
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
  "savages", "monkeys", "apes", "a plague", "not human", "less than human", "inferior", "filth", "groomers", "pedos",
  "pedophiles", "predators", "mentally ill", "a mental illness", "terrorists", "criminals", "rapists", "thieves", "a virus",
  "scum", "trash", "garbage", "evil", "dirty",
]);
const ERASURE = alt([
  "exterminated", "gassed", "eradicated", "wiped out", "sterilized", "put in camps", "killed", "purged",
  "lynched", "hanged", "burned", "banned from existing", "shot",
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
    "six million wasnt enough", "go back to your country", "go back to africa", "go back to mexico",
  ]),
];
const HATE_DISLIKE = new RegExp(
  ` i ${alt(["hate", "despise", "cant stand"])} (?:${alt(["all", "every", "those", "these", "the", "fucking"])} )?${GROUPS} `,
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
  "moan", "moans", "moaning", "unzip", "unzips", "strip", "strips", "undress", "undresses", "grope", "gropes",
  "licks your", "licks ur", "thrust", "thrusts", "grinds on", "spank", "spanks", "bends over", "pulls down your pants",
  "pulls down ur pants", "takes off your", "takes off ur", "kisses your neck", "kisses down your", "touches your",
  "rubs your", "naked", "nude", "cums",
]);
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
const MINOR_AGE =
  /\b(?:[1-9]|1[0-7])\s*(?:yo|y\/o|yrs? old|years? old)\b|\b(?:im|i'm|i am|shes|she's|she is|hes|he's|he is|youre|you're|you are|ur)\s+(?:only\s+|just\s+)?(?:[1-9]|1[0-7])\b(?!\s*(?:am|pm|min|mins|minutes|hours|hrs|days|weeks|%|k\b|m\b|ft|feet|inches|cm|kg|lbs|dollars|bucks|kills|wins|points|:|\.\d))/;
const SEX_EDUCATION = / sex (?:ed|education) /g;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;
const SPELLED_EMAIL = /\b[a-z0-9._-]{3,}\s*[[(]?\s*at\s*[\])]?\s*[a-z0-9-]+\s*[[(]?\s*dot\s*[\])]?\s*(?:com|net|org|edu|io|co|me)\b/;
const PHONE = /(?<![\d.])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\d.])/;
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
  "i have your address", "i got your address", "i know your ip", "i know ur ip",
]);
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
  if (text.tokens.some((token) => variants(token).some((variant) => WORD_SLUR.test(variant)))) return true;
  if (text.tokens.some((token) => REVERSED_SLUR.test(token))) return true;
  const squashed = text.tokens.some((token) => EMBEDDED_EXCEPTIONS.test(token))
    ? text.tokens.filter((token) => !EMBEDDED_EXCEPTIONS.test(token)).join("")
    : text.squashed;
  if (EMBEDDED_SLUR.test(squashed) || EMBEDDED_SLUR.test(squashed.replace(/q/g, "g"))) return true;
  return SLUR_PHRASES.test(text.plain);
}

function selfHarmVerdict(text: ModerationText): ModerationVerdict | null {
  let matched = false;
  for (const match of text.plain.matchAll(SELF_HARM)) {
    matched = true;
    const before = wordsBefore(text.plain, match.index, 3);
    if (before.some((word) => NEGATIONS.has(word)) || REPORTED.test(before.join(" "))) continue;
    if (!before.some((word) => SECOND_PERSON.has(word)) && before.some((word) => FIRST_PERSON.has(word))) {
      if (GAMING.test(text.plain) || match[0] === phrase("go die")) continue;
      return blocked("crisis", 0);
    }
    return blocked("self_harm", 3);
  }
  return !matched && compactHas(text, SELF_HARM_COMPACT) ? blocked("self_harm", 3) : null;
}

function hasCrisis(text: ModerationText): boolean {
  if (SEEKING_METHODS.test(text.plain) || SUICIDAL_THOUGHTS.test(text.plain)) return true;
  if (SUICIDAL.test(text.plain) && !negated(text.plain, text.plain.indexOf(" suicidal ") + 1)) return true;
  let matched = false;
  for (const match of text.plain.matchAll(CRISIS)) {
    matched = true;
    if (negated(text.plain, match.index)) continue;
    if (match[0] === "kms" && KILOMETERS.test(text.folded)) continue;
    return true;
  }
  if (!GAMING.test(text.plain)) {
    for (const match of text.plain.matchAll(ENDING_IT)) {
      if (!negated(text.plain, match.index)) return true;
    }
  }
  return !matched && compactHas(text, CRISIS_COMPACT);
}

function threatVerdict(text: ModerationText): ModerationVerdict | null {
  const severe = REAL_WORLD.test(text.plain);
  if (THREATS.test(text.plain) || MASS_VIOLENCE.test(text.plain) || EXTORTION.test(text.plain)) return blocked("threat", 3);
  if (WATCH_YOUR_BACK.test(text.plain) && !GAMING.test(text.plain)) return blocked("threat", 3);
  for (const match of text.plain.matchAll(VIOLENT_INTENT)) {
    if (negated(text.plain, match.index + 1)) continue;
    const [next = "", after = ""] = text.plain.slice(match.index + match[0].length).split(" ");
    if (HARMLESS_OBJECTS.has(next) || ((next === "a" || next === "an") && HARMLESS_SENDS.has(after))) continue;
    if (SEVERE_VIOLENCE.test(match[0]) || severe) return blocked("threat", 3);
    if (GAMING.test(text.plain)) continue;
    const joking = JOKING.test(text.plain) || JOKING_SYMBOLS.test(text.folded);
    return blocked("threat", joking ? 1 : 3);
  }
  return null;
}

function hasExtremeHarassment(text: ModerationText): boolean {
  if (HARASSMENT.test(text.plain) || HARASS_CALL.test(text.plain)) return true;
  for (const match of text.plain.matchAll(DEATH_WISH)) {
    if (!negated(text.plain, match.index + 1)) return true;
  }
  return false;
}

function sexualVerdict(text: ModerationText): ModerationVerdict | null {
  const plain = text.plain.replace(SEX_EDUCATION, " ");
  const explicit = EXPLICIT.test(plain);
  if (MINOR_SEXUAL.test(plain) || CP_TRADE.test(plain)) return blocked("sexual", 3);
  if (explicit && (MINORS.test(plain) || MINOR_AGE.test(text.folded))) return blocked("sexual", 3);
  if (SEXUAL.test(plain) || SEND_BODY.test(plain) || CUM.test(plain) || RULE_34.test(text.folded)) return blocked("sexual", 2);
  for (const match of text.folded.matchAll(ROLEPLAY_ACTION)) {
    if (ROLEPLAY.test(readModerationText(match[1] ?? "").plain)) return blocked("sexual", 2);
  }
  return null;
}

function vocabulary(list: string[]): RegExp {
  return new RegExp(` (?:${list.map((word) => (word.endsWith("*") ? `${phrase(word.slice(0, -1))}[a-z]*` : phrase(word))).join("|")}) `);
}

const MODEL_GATES: Record<string, RegExp> = {
  crisis: vocabulary([
    "die", "dying", "dead", "death", "kil*", "suicid*", "alive", "exist*", "end*", "gone", "wake", "pil*", "cut*",
    "hurt*", "rope", "hang*", "jump*", "bleach", "overdos*", "harm*", "disapear*", "living", "life", "goodbye", "kms",
  ]),
  self_harm: vocabulary([
    "die", "dead", "death", "kil*", "kys", "suicid*", "exist*", "end*", "gone", "pil*", "cut*", "rope", "hang*", "neck",
    "jump*", "bleach", "overdos*", "alive", "unalive", "traffic", "bridge", "train",
  ]),
  threat: vocabulary([
    "kil*", "murder*", "shoot*", "stab*", "hurt*", "strangl*", "chok*", "rape*", "behead*", "bomb*", "swat*", "tortur*",
    "slit*", "kidnap*", "stalk*", "beat*", "break*", "bury", "end", "hunt*", "find", "house", "adres*", "school", "gun*",
    "knife", "weapon*", "hamer", "machete", "rifle", "hospital", "bone*", "dead", "die", "leak*", "door", "regret*",
  ]),
  harassment: vocabulary([
    "die*", "dead", "death", "cancer", "rape*", "abort*", "kil*", "shoot", "shot", "burn*", "rot", "sufer*", "funeral",
    "exist", "live", "deserve*", "bully", "harass*", "spam", "tortur*", "stab*", "crash", "drown", "sick", "put down",
  ]),
  sexual: vocabulary([
    "sex*", "nude*", "nod*", "naked", "cum*", "dick*", "cock*", "pusy", "tit*", "bob*", "body", "thigh*", "nip*", "bals",
    "suck*", "lick*", "ride", "finger*", "moan*", "wet", "hard", "jerk*", "fap*", "strip*", "undres*", "grind*", "spank*",
    "bend", "spread", "onlyfans", "nsfw", "lewd*", "erp", "hentai", "porn*", "cam", "inside", "loli*", "horny", "feet",
  ]),
  hate: vocabulary([
    "jew*", "muslim*", "black*", "gay*", "lesbian*", "trans*", "imigrant*", "refuge*", "mexican*", "asian*", "chinese",
    "arab*", "indian*", "latino*", "women", "christian*", "hindu*", "disabled", "african*", "white*", "native*", "sikh*",
    "migrant*", "foreign*", "gyps*", "roma", "quer*", "homosexual*", "autistic", "bisexual*",
  ]),
};

const decodedLabels = moderationModel.labels.map((label) => {
  const bytes = Uint8Array.from(atob(label.weights), (char) => char.charCodeAt(0));
  return {
    name: label.name,
    bias: label.bias,
    scale: label.scale,
    threshold: label.threshold,
    weights: new Int8Array(bytes.buffer),
  };
});

export function modelScores(text: ModerationText): Record<string, number> {
  const buckets = featureBuckets(text.contentTokens, moderationModel.buckets);
  const scores: Record<string, number> = {};
  for (const label of decodedLabels) {
    let sum = label.bias;
    for (const bucket of buckets) sum += (label.weights[bucket] ?? 0) * label.scale;
    scores[label.name] = 1 / (1 + Math.exp(-sum));
  }
  return scores;
}

function modelVerdict(text: ModerationText): ModerationVerdict {
  const scores = modelScores(text);
  let worst: (typeof decodedLabels)[number] | undefined;
  for (const label of decodedLabels) {
    const score = scores[label.name] ?? 0;
    if (!MODEL_GATES[label.name]?.test(text.plain)) continue;
    if (score >= label.threshold && (!worst || score - label.threshold > (scores[worst.name] ?? 0) - worst.threshold)) worst = label;
  }
  if (!worst) return ALLOWED;
  const category = worst.name as ModerationCategory;
  return blocked(category, category === "crisis" ? 0 : 1);
}

export function moderate(input: string): ModerationVerdict {
  const text = readModerationText(input);
  if (!text.tokens.length && !/\d/.test(text.folded)) return ALLOWED;

  if (hasSlur(text)) return blocked("slur", 3);
  const sexual = sexualVerdict(text);
  if (sexual?.strikes === 3) return sexual;
  const selfHarm = selfHarmVerdict(text);
  if (selfHarm) return selfHarm;
  if (hasCrisis(text)) return blocked("crisis", 0);
  const threat = threatVerdict(text);
  if (threat) return threat;
  if (HATE_RULES.some((rule) => rule.test(text.plain)) || HATE_NUMBERS.test(text.folded)) {
    return blocked("hate", 3);
  }
  if (HATE_DISLIKE.test(text.plain)) return blocked("hate", 2);
  if (hasExtremeHarassment(text)) return blocked("harassment", 2);
  if (sexual) return sexual;
  const targetedDox = DOX_TARGET.test(text.plain) || DOX_WORDS.test(text.plain) || DOX_INTENT.test(text.plain);
  if (targetedDox) return blocked("doxxing", 3);
  if (hasPersonalInfo(text.folded)) return blocked("doxxing", 1);

  if (!text.contentTokens.length) return ALLOWED;
  return modelVerdict(text);
}
