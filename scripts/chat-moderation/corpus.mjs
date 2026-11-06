const slots = {
  name: ["alex", "sam", "jordan", "kai", "mia", "leo", "nova", "riley", "ash", "zoe", "this guy", "that girl", "bro", "dude", "he", "she"],
  a: ["a", "such a", "a total", "a complete", "an absolute", "a fucking", "the biggest"],
  insult: [
    "idiot", "moron", "loser", "clown", "dumbass", "failure", "waste of space", "piece of trash", "piece of garbage",
    "joke", "freak", "creep", "bitch", "asshole", "dickhead", "prick", "twat", "cunt", "scumbag", "degenerate",
    "imbecile", "buffoon", "bozo", "simp", "incel", "fatass", "pig", "lowlife", "piece of shit", "dumb fuck",
    "nobody", "embarrassment", "disgrace", "rat", "snake", "weirdo", "nerd with no life", "noob", "bot", "tryhard",
  ],
  adj: [
    "stupid", "dumb", "ugly", "worthless", "pathetic", "useless", "disgusting", "braindead", "fat", "clueless",
    "gross", "hideous", "annoying", "irrelevant", "unlovable", "insufferable", "talentless", "trash", "bad", "mid",
  ],
  pos: [
    "awesome", "amazing", "so cool", "really nice", "funny", "smart", "kind", "the best", "a legend", "very talented",
    "great at this", "a good friend", "right", "hilarious", "so helpful", "wholesome", "goated", "cracked at this game",
  ],
  meh: ["stupid", "dumb", "trash", "garbage", "annoying", "broken", "terrible", "awful", "the worst", "so bad", "useless", "cursed"],
  thing: [
    "this game", "this level", "my wifi", "the boss fight", "the new update", "this lag", "the ending", "my code", "this song",
    "the weather", "school today", "my phone", "the matchmaking", "this captcha", "monday", "the final exam", "my laptop",
  ],
  group: [
    "jews", "muslims", "black people", "blacks", "gays", "gay people", "lesbians", "trans people", "immigrants", "refugees",
    "mexicans", "asians", "chinese people", "arabs", "indians", "latinos", "women", "christians", "hindus", "disabled people",
    "africans", "white people", "native americans", "sikhs", "jewish people", "trans women", "migrants", "foreigners",
  ],
  groupAdj: ["gay", "trans", "black", "jewish", "muslim", "disabled", "asian", "mexican", "autistic", "lesbian", "bisexual", "indian", "arab"],
  dehum: [
    "animals", "subhuman", "vermin", "parasites", "rats", "cockroaches", "a disease", "a cancer", "savages", "filth", "trash",
    "garbage", "inferior", "monkeys", "apes", "pigs", "dogs", "scum", "evil", "a plague", "worthless", "not human", "mentally ill",
    "all criminals", "all terrorists", "disgusting", "a mistake", "ruining everything", "less than human", "groomers",
  ],
  fate: [
    "exterminated", "gassed", "wiped out", "killed", "banned from existing", "put in camps",
    "eradicated", "sterilized", "burned", "hanged", "shot", "erased", "purged",
  ],
  role: ["mod", "admin", "owner", "helper", "moderator"],
  game: ["minecraft", "fortnite", "roblox", "valorant", "chess", "smash", "rocket league", "terraria", "osu", "among us", "geometry dash", "bedwars", "apex"],
  anime: ["frieren", "one piece", "jjk", "chainsaw man", "spy x family", "bocchi", "naruto", "demon slayer", "mob psycho", "haikyuu"],
  victim: ["you", "u", "your mom", "your family", "ur dad", "your little sister", "your whole family", "your dog", "your parents", "your kids"],
  harm: [
    "die", "get cancer", "get hit by a bus", "get run over", "burn alive", "rot", "suffer forever", "choke on your food",
    "drown", "get shot", "get stabbed", "die slowly", "die alone", "get raped", "get tortured", "die in a car crash",
  ],
  act: ["kill", "murder", "stab", "shoot", "strangle", "hurt", "beat", "break", "end", "slit", "choke", "bury"],
  weapon: ["knife", "gun", "bat", "hammer", "machete", "crowbar", "rifle"],
  crush: [
    "he", "she", "him", "her", "that guy", "this girl", "gojo", "levi", "makima", "my crush", "that streamer", "the singer",
    "the new character", "the drummer", "toji", "nanami", "power", "yor", "the villain",
  ],
  body: ["dick", "cock", "pussy", "tits", "boobs", "ass", "body", "thighs", "nipples", "balls"],
  sexact: ["suck", "lick", "ride", "finger", "eat", "touch", "grab", "rub", "bite", "spank"],
  rpact: [
    "moans", "unzips your pants", "pulls your shirt off", "grinds on your lap", "kisses down your stomach", "strips slowly",
    "bends over for you", "touches you down there", "slides my hand into your pants", "pins you down and undresses you",
  ],
  climax: ["cum", "finish", "scream", "can't walk", "shake", "beg for more"],
  pain: ["tired", "sad", "empty", "numb", "exhausted", "alone", "worthless", "broken", "hopeless", "done"],
  wish: [
    "have a great day", "win", "feel better", "get well soon", "pass your exam", "like it", "enjoy it", "had fun", "sleep well",
    "dont die in the next round", "get the job", "find it", "are okay", "have fun", "get your rank back", "beat the boss",
  ],
  place: ["canada", "texas", "niger", "the uk", "a small town", "the city", "brazil", "germany", "the philippines", "ohio"],
  daily: [
    "was late to class", "was tardy again", "dont like mushrooms", "dont watch {anime}", "dont know", "dont care", "want to sleep",
    "want pizza", "want to go home", "wanna play {game}", "feel sick", "cut my hair", "cut myself cooking lol", "cut my finger",
    "hurt my leg at practice", "almost died in {game}", "am dying to play {game}", "want to end this match", "was born in {place}",
    "live in {place}", "want to disappear into my bed", "dont want to go to school", "dont wanna do homework", "want to be a {role}",
    "dont see the point of this assignment", "am done with this level", "need a nap", "hate waking up early", "miss my cat",
  ],
  someone: ["my friend", "my brother", "my cousin", "my sister", "a kid at my school", "my uncle", "the main character", "he", "she", "someone i know"],
  passed: [
    "tried to kill himself last year and is doing better now", "attempted suicide but got help", "is in therapy for self harm",
    "killed himself in the show", "died last week", "passed away", "overdosed in the movie", "talked about suicide in class today",
    "struggled with self harm and is okay now", "survived a suicide attempt",
  ],
  stance: ["thats gross", "stop saying that", "thats so wrong", "how is that even a take", "touch grass", "be better"],
  event: ["recital", "concert", "tournament", "game tonight", "presentation", "audition", "exam", "show", "interview", "match"],
};

const harassment = [
  "i hope {victim} {harm}", "i really hope {victim} {harm}", "hope {victim} {harm}", "i wish {victim} would {harm}",
  "i pray {victim} {harm}", "{victim} should {harm}", "{victim} deserves to {harm}", "you deserve to {harm}",
  "you should have been aborted", "your mom should have aborted you", "your parents should have swallowed you",
  "someone should {act} you", "somebody needs to {act} you already", "the world needs someone to {act} you",
  "i would laugh if {victim} died", "i'd celebrate the day you die", "i can't wait for you to die",
  "nobody would care if your family died", "your mom is going to die alone", "i hope your house burns down with you in it",
  "everyone go harass {name}", "lets all bully {name} until they leave", "go spam {name} dms with hate", "lets make {name} cry until they quit",
  "you are a subhuman waste and should not exist", "you dont deserve to live", "people like you should be put down",
  "you deserve every bad thing that happens to you", "i hope you get what's coming to you and die", "i hope your kids get sick",
  "you deserve to get raped", "go get raped", "i hope someone {act}s you", "if you died nobody would come to your funeral",
  "nobody would cry at your funeral", "nobody will show up to your funeral", "your funeral will be empty",
  "your family would be happier if you were dead", "the world would celebrate if you died", "i'd dance on your grave",
];

const threat = [
  "i'm going to find you and {act} you", "i will find where you live and {act} you", "ill {act} you when i see you",
  "you'll regret this when i {act} you", "im coming to your house with a {weapon}", "i'll bring my {weapon} to your school",
  "i will end you for real", "count your days", "ur dead when i see you", "i'll make sure you never walk again",
  "better hide because im coming for you", "i'll put you in the hospital", "you won't see tomorrow", "i know your address now",
  "i'll show up at your door", "sleep with one eye open tonight", "i'm going to {act} {victim}", "imma {act} you for real",
  "i swear ill {act} you", "i'm going to rape you", "i will kidnap you", "i'm going to shoot up the school tomorrow",
  "bringing a {weapon} to school tomorrow dont come", "i will leak your pics if you dont send more", "send me money or i leak everything",
  "i have your address and im coming", "you better watch out irl", "i'll break every bone in your body",
];

const selfHarm = [
  "you should just end it", "do the world a favor and disappear permanently", "nobody would notice if you were gone",
  "why dont you just go hang", "the rope is waiting for you", "end it already nobody cares", "please just stop existing",
  "go jump in front of a train", "just kill yourself already", "kys {insult}", "go kys", "you should kys", "kill urself",
  "neck yourself {insult}", "drink bleach {insult}", "nobody would miss you if you died", "do everyone a favor and die",
  "you should take all your pills", "the world is better without you", "go cut yourself again", "just end your life",
  "you'd be better off dead", "go unalive yourself", "you should hang yourself", "why are you still alive", "just die already",
  "you are better off dead {insult}", "take a long walk off a short bridge", "go play in traffic", "commit die",
];

const crisis = [
  "i dont see the point of living anymore", "i want to sleep and never wake up", "everyone would be better off without me",
  "ive been thinking about ending it", "i cant take it anymore i want to be gone", "i have a plan to end things",
  "ive been hurting myself again", "i relapsed and cut", "i keep thinking about jumping", "nobody would miss me if i was gone",
  "im tired of being alive", "i just want to disappear forever", "i wrote my goodbye letter", "this is my last day here",
  "im going to end it tonight", "i want to die", "i wanna die so bad", "i want to kill myself", "kms", "i feel so {pain} i want to die",
  "im so {pain} i want to end it all", "i dont want to be here anymore", "i wish i was never born", "i hate being alive",
  "how many pills would it take", "whats the most painless way to go", "i keep cutting myself", "i started self harming again",
  "im suicidal", "i feel suicidal", "i have suicidal thoughts", "i want to end my life", "i dont want to live anymore",
  "im gonna kms", "life isnt worth living", "i want to stop existing", "i wish i could just not wake up", "i give up on life",
];

const sexual = [
  "i want to {sexact} your {body}", "let me {sexact} your {body}", "i'm going to {sexact} your {body} all night",
  "send me pics of your {body}", "show me your {body}", "send nudes", "wanna see my {body}", "rate my {body}",
  "wanna sext", "lets do nsfw rp in dms", "anyone want to erp", "dm me for lewd pics", "who wants to cyber",
  "i'm touching myself thinking about you", "i want you to {sexact} me until i {climax}", "dm me if you want to see me naked",
  "*{rpact}*", "*{rpact}* mmm", "{rpact} for you", "i'm so wet right now", "i'm so hard for you", "i want to make you moan",
  "i want to feel you inside me", "i'm jerking off right now", "fuck me harder daddy", "i'm gonna cum", "i want your cum",
  "spread your legs for me", "bend over so i can {sexact} your {body}", "can i see your {body} on cam", "lets have sex",
  "want to have sex with me", "i'll {sexact} your {body} so good", "sit on my face", "eat me out", "suck me off",
  "check out my onlyfans", "selling nudes dm me", "trading nsfw pics", "send me hentai", "post your feet pics for me",
  "im 14 and horny", "any girls under 16 want to sext", "i like little girls", "loli hentai is the best",
  "can i see you naked", "get naked for me", "take your clothes off for me", "strip for me on cam", "show me on cam",
  "wanna video call naked", "i want to see you without clothes", "let me see what's under your shirt", "i want you inside me",
];

const hate = [
  "{group} are {dehum}", "all {group} are {dehum}", "{group} should be {fate}", "i hate {group}", "i hate all {group}",
  "{group} dont deserve rights", "{group} are ruining this country", "get rid of all the {group}", "{group} need to be {fate}",
  "no {group} allowed", "{group} are the worst", "{group} belong in cages", "{group} should go back where they came from",
  "death to {group}", "death to all {group}", "{groupAdj} people are {dehum}", "{groupAdj} people should not exist",
  "being {groupAdj} is a disease", "every single one of the {group} should be {fate}", "{group} are not people",
  "the world would be better without {group}", "we need to get rid of {group}", "{group} are a plague on society",
  "i wish all {group} were {fate}", "{group} have no place here", "{groupAdj} people are a mistake", "kill all {group}",
  "{group} should not be allowed to vote", "{group} are inferior to us", "never trust {group} they are {dehum}",
];

const benign = [
  "hey everyone", "hi chat", "hello!", "whats up", "how is everyone doing", "good morning", "good night guys", "gn",
  "lol", "lmao", "that's so funny", "brb", "back", "anyone here", "same", "fr", "true", "no way", "omg", "gg", "gg wp",
  "nice", "what are you playing", "do you want to play {game}", "anyone want to play {game}", "i love {game}",
  "{game} is so fun", "i just beat {game}", "has anyone watched {anime}", "{anime} is peak", "{anime} season 2 when",
  "what anime are you watching", "i'm watching {anime} right now", "you are {pos}", "you're {pos}", "{name} is {pos}",
  "{name} you are {pos}", "thank you {name}", "thanks for the help", "you did great", "you got this", "can you help me",
  "how are you", "how are you doing today", "i miss you guys", "see you later", "see you tomorrow", "you're right",
  "you are welcome", "i agree with you", "you're not stupid at all", "you are not a loser", "don't call yourself an idiot",
  "ignore the trolls you are {pos}", "you are not {adj}", "i was being dumb sorry", "{thing} is {meh}", "{thing} is so {meh}",
  "{thing} is kinda {meh} ngl", "i'm so dumb lol i forgot", "i'm such an idiot i left my charger at home", "i feel stupid today",
  "my code is garbage lol", "that was a stupid mistake on my part", "fuck this level lol", "holy shit that was close",
  "damn that's crazy", "wtf just happened", "this song slaps", "the ending was trash honestly", "i died again lol",
  "this lag is killing me", "i'm dead lmao", "that joke killed me", "you killed it", "you're killing it today",
  "i killed the boss finally", "the final boss destroyed me", "i got destroyed in ranked", "rip my rank", "where are you from",
  "what time is it there", "i'm from canada", "it's raining here", "what's everyone eating", "pizza or burgers",
  "i need sleep", "school was long today", "my cat is sleeping on my keyboard", "does anyone know a good movie",
  "recommend me some music", "who else is bored", "i'm bored", "let's play something", "this site is cool",
  "how do i open a new tab", "the proxy is fast today", "which game should i try", "any good anime recs",
  "{group} deserve respect", "{group} are welcome here", "i have friends who are {groupAdj}", "my best friend is {groupAdj}",
  "i'm {groupAdj} and proud", "learning about the history of {group} today", "there are lots of {group} in my city",
  "{groupAdj} rights are human rights", "support {groupAdj} creators", "{groupAdj} representation in games is cool",
  "i'm reading a book by {groupAdj} authors", "hate against {group} is wrong", "racism against {group} needs to stop",
  "people who hate {group} are wrong", "being {groupAdj} is not a disease", "{group} are people too", "{group} are not {dehum}",
  "my neighbors are {groupAdj}", "i'm learning about {groupAdj} culture", "happy holidays to all the {group} here",
  "{groupAdj} food is so good", "{groupAdj} history month is coming up", "i'm going to kill this level", "kill the lights pls",
  "i'm going to destroy you in {game} lol", "i'll beat you at {game}", "you're dead meat in {game}", "1v1 me in {game}",
  "the villain kills everyone in {anime}", "the main character dies in {anime}", "spoilers but he dies",
  "i hate mondays", "i hate this weather", "i hate homework", "i hate when my game crashes", "everyone hates mondays",
  "nobody likes homework", "shut up that's amazing", "stop it you're making me laugh", "you're so funny i can't",
  "bro you're insane at this", "you're a beast", "you absolute legend", "you're a menace lol", "this is cursed",
  "that's sick", "that's wild", "insane play", "nice shot", "clutch", "carry me pls", "teach me your ways",
  "can i be a mod pls", "can i be a {role}", "how do i become a {role}", "who are the {role}s here", "i want to be a {role} someday",
  "can i be your friend", "i want to be a streamer", "i'd love to be {pos}", "you should be proud", "we should all be friends",
  "everyone should be nice here", "people should be kind", "{group} should be respected", "{group} should be treated equally",
  "{group} should be welcome everywhere", "it should be fine", "that should be easy", "should i be worried", "can it be friday already",
  "the {role}s are doing a good job", "thanks {role}s", "is there a {role} online", "be a good sport", "be nice to each other",
  "fuck you {insult}", "fuck you lol", "fuck off {insult}", "shut the fuck up {insult}", "stfu {insult}", "you're {a} {insult}",
  "you're such {a} {insult} lmao", "{name} is {a} {insult}", "{name} is {a} {insult} lol", "ur so {adj} at {game}",
  "you're so {adj}", "ur {adj}", "you suck at {game}", "get good {insult}", "skill issue", "cry about it", "ratio", "L bozo",
  "nobody asked {insult}", "go touch grass", "eat shit", "kiss my ass", "suck my dick lol", "bite me", "come at me bro",
  "fight me", "i'll beat your ass in {game}", "you're dead in {game}", "i will destroy you in {game}",
  "i'm gonna kill you in {game}", "die noob ez", "ez clap {insult}", "you're trash at {game}", "uninstall {game} {insult}",
  "i hate you lmao", "i hate you so much {name} lol", "you're the worst {name} lol", "shut up {insult} lol", "i'm gonna smack you lol",
  "you're annoying as hell", "wtf is wrong with you lol", "are you stupid", "what a dumbass take", "ur mom lol", "your mom is so fat lol",
  "what the fuck", "holy fuck", "fucking hell", "this shit is fire", "damn bro", "bitch please", "this bitch of a level", "stupid ass game",
  "{crush} is so hot", "omg {crush} is so fine", "ill let {crush} crack", "{crush} can get it", "i'd smash {crush}",
  "{crush} is lowkey hot", "{crush} can rail me ngl", "marry me {crush}", "i'm in love with {crush}", "{crush} has such a sexy voice",
  "{crush} is so thicc", "{crush} is my husband", "{crush} is my wife", "i want to kiss {crush}", "i'd let {crush} do anything",
  "{crush} is so attractive", "i have a crush on {name}", "date me {name}", "you're cute", "{crush} is so pretty", "{crush} ate",
  "{crush} is a snack", "he's so fine it hurts", "she's gorgeous", "he's built like a god", "abs for days", "rizz god",
  "sex ed was awkward today", "the sex scene in that movie was cringe", "is it normal to not want a relationship", "i don't watch hentai lol",
  "that anime has way too much fanservice", "mark it nsfw please", "no nsfw in this channel", "please keep it sfw",
  "please don't hurt yourself", "if you're struggling please talk to someone", "suicide prevention matters", "my friend is going through a lot",
  "i'm dying of laughter", "this exam is killing me", "kill me now this lag is awful lol", "i almost died laughing", "rip me",
  "i'm so {pain} today", "i'm sad today", "i feel lonely", "i had a rough day", "i'm stressed about exams", "depression is hard",
  "therapy helped me a lot", "mental health matters", "you matter", "reach out if you need to talk", "i'm here for you {name}",
  "i'm glad you're still here", "take care of yourself", "drink water and sleep", "self care day", "i'm proud of you for getting help",
  "the war killed millions", "the villain murders his brother", "he dies at the end of the movie", "the zombies killed everyone",
  "kill the heat after it boils", "i'll kill this exam", "my phone died", "the battery is dead", "dead silence in here",
  "i'll end your winning streak", "watch me end your career in {game}", "i'll shoot you a message later", "shoot me a dm",
  "i'm gonna hang out later", "i'll hang the poster", "that cut was clean", "cut the cake", "the knife set is on sale",
  "jump off the cliff in {game} to skip", "i fell off a cliff in {game}", "i drowned in {game} again", "i keep dying to the boss",
  "the boss killed me", "dying is part of the game", "die in the game and you respawn", "she killed it on stage",
  "i hope you {wish}", "hope you {wish}", "i really hope you {wish}", "i {daily}", "i {daily} lol", "ngl i {daily}",
  "please dont kill yourself we love you", "dont kys pls", "you shouldnt kill yourself", "never kill yourself over a game",
  "you dont deserve to die", "nobody wants you to die", "please stay safe", "dont hurt yourself ok", "you are loved",
  "my friend tried to kill himself and now hes getting help", "he committed suicide in {anime}", "suicide squad was mid",
  "the suicide rate is rising", "suicide prevention month is in september", "the character killed himself in the finale",
  "i drove 50 kms today", "its 20 kms away", "we walked 5 kms", "i hate when {group} get harassed", "i hate how people treat {group}",
  "i hate racism against {group}", "im so horny lol", "go to horny jail", "horny on main", "im gonna hang out later",
  "were hanging out tonight", "ill shoot you a dm", "shoot you a text later", "ill hit you up later", "she's gonna kill it at the show",
  "i'll hurt your feelings lol", "im gonna end your streak", "watch your back next round", "i'll find you in the lobby",
  "i'm coming for your rank", "i'm gonna beat you so bad in {game}", "i will end your whole career in {game}",
  "{someone} {passed}", "{someone} {passed} and i'm glad they're okay", "i'm worried because {someone} {passed}",
  "{group} are not {dehum}, {stance}", "saying {group} are {dehum} is gross", "stop saying {group} are {dehum}",
  "no {group} are not {dehum}", "{group} are people not {dehum}", "calling {group} {dehum} is hate speech",
  "im going to kill it at my {event}", "gonna kill it today", "you're gonna kill it at the {event}", "she killed it at the {event}",
  "we're going to crush the {event}", "i'm gonna destroy this {event}",
  "i would never {act} you", "i'd never hurt you", "nobody is going to hurt you", "relax nobody wants to {act} you",
  "careful you might cut yourself", "dont cut yourself on the knife", "you could hurt yourself doing that", "be careful not to fall",
  "my dog died last year and i still miss him", "my cat passed away and i miss her", "rip to my goldfish i miss him",
  "my grandpa died when i was little", "i miss my old friends", "we lost my aunt last month",
];

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function expand(template, random) {
  return template.replace(/\{(\w+)\}/g, (_, slot) => {
    const options = slots[slot];
    return expand(options[Math.floor(random() * options.length)], random);
  });
}

export const MODERATION_LABELS = ["threat", "self_harm", "crisis", "harassment", "sexual", "hate"];

function sample(templates, perTemplate, random, label) {
  const labels = Object.fromEntries(MODERATION_LABELS.map((name) => [name, name === label ? 1 : 0]));
  const rows = new Map();
  for (const template of templates) {
    const count = template.includes("{") ? perTemplate : 1;
    for (let index = 0; index < count; index += 1) {
      const text = expand(template, random);
      rows.set(text, { text, labels });
    }
  }
  return [...rows.values()];
}

export function buildModerationCorpus(seed = 1337) {
  const random = seeded(seed);
  return [
    ...sample(threat, 30, random, "threat"),
    ...sample(selfHarm, 30, random, "self_harm"),
    ...sample(crisis, 30, random, "crisis"),
    ...sample(harassment, 30, random, "harassment"),
    ...sample(sexual, 30, random, "sexual"),
    ...sample(hate, 40, random, "hate"),
    ...sample(benign, 30, random, null),
  ];
}
