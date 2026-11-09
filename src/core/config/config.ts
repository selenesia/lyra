import { encodeMochiUrl } from "../runtime/utils.ts";
import { isStatic } from "../runtime/hosting.ts";

export interface Bookmark {
  name: string;
  url: string;
  icon?: string;
}

export const DEFAULT_BOOKMARKS: Bookmark[] = [
  {
    name: "mangas",
    url: "https://atsu.moe/",
    icon: `/!cover!/${encodeMochiUrl("https://atsu.moe/favicon.ico")}/`,
  },
  { name: "games", url: "lyra://games" },
  { name: "watch", url: "lyra://watch" },
  ...(!isStatic ? [{ name: "chats", url: "lyra://chat" }] : []),
  { name: "youtube", url: "https://youtube.com/" },
];

export const SEARCH_ENGINES = {
  duckduckgo: "https://duckduckgo.com/?q=",
  brave: "https://search.brave.com/search?q=",
  yep: "https://yep.com/?q=",
  swisscows: "https://swisscows.com/en/web?query=",
  google: "https://www.google.com/search?q=",
} as const;

export type SearchEngineKey = keyof typeof SEARCH_ENGINES;
export const SEARCH_ENGINE_OPTIONS = [
  "duckduckgo",
  "brave",
  "yep",
  "swisscows",
  "google",
] as const satisfies readonly SearchEngineKey[];

export const BANGS = {
  yt: {
    name: "YouTube",
    url: "https://www.youtube.com/results?search_query={query}",
  },
  youtube: {
    name: "YouTube",
    url: "https://www.youtube.com/results?search_query={query}",
  },
  fb: {
    name: "Facebook",
    url: "https://www.facebook.com/search/top/?q={query}",
  },
  facebook: {
    name: "Facebook",
    url: "https://www.facebook.com/search/top/?q={query}",
  },
  ig: {
    name: "Instagram",
    url: "https://www.instagram.com/explore/tags/{query}/",
  },
  instagram: {
    name: "Instagram",
    url: "https://www.instagram.com/explore/tags/{query}/",
  },
  tw: { name: "Twitter", url: "https://twitter.com/search?q={query}" },
  twitter: { name: "Twitter", url: "https://twitter.com/search?q={query}" },
  tt: { name: "TikTok", url: "https://www.tiktok.com/search?q={query}" },
  tiktok: { name: "TikTok", url: "https://www.tiktok.com/search?q={query}" },
  rd: { name: "Reddit", url: "https://www.reddit.com/search/?q={query}" },
  reddit: { name: "Reddit", url: "https://www.reddit.com/search/?q={query}" },
  dc: { name: "Discord", url: "https://discord.com/channels/@me" },
  discord: { name: "Discord", url: "https://discord.com/channels/@me" },
  w: {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Special:Search?search={query}",
  },
  wiki: {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Special:Search?search={query}",
  },
  wikipedia: {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Special:Search?search={query}",
  },
  imdb: { name: "IMDb", url: "https://www.imdb.com/find?q={query}" },
  stack: {
    name: "Stack Overflow",
    url: "https://stackoverflow.com/search?q={query}",
  },
  so: {
    name: "Stack Overflow",
    url: "https://stackoverflow.com/search?q={query}",
  },
  gh: { name: "GitHub", url: "https://github.com/search?q={query}" },
  github: { name: "GitHub", url: "https://github.com/search?q={query}" },
  am: { name: "Amazon", url: "https://www.amazon.com/s?k={query}" },
  amazon: { name: "Amazon", url: "https://www.amazon.com/s?k={query}" },
  ebay: { name: "eBay", url: "https://www.ebay.com/sch/i.html?_nkw={query}" },
  walmart: { name: "Walmart", url: "https://www.walmart.com/search?q={query}" },
  netflix: { name: "Netflix", url: "https://www.netflix.com/search?q={query}" },
  spotify: { name: "Spotify", url: "https://open.spotify.com/search/{query}" },
  ytm: {
    name: "YouTube Music",
    url: "https://music.youtube.com/search?q={query}",
  },
  news: {
    name: "Google News",
    url: "https://news.google.com/search?q={query}",
  },
  weather: {
    name: "Weather",
    url: "https://www.google.com/search?q=weather+{query}",
  },
  maps: {
    name: "Google Maps",
    url: "https://www.google.com/maps/search/{query}",
  },
  translate: {
    name: "Google Translate",
    url: "https://translate.google.com/?sl=auto&tl=en&text={query}",
  },
  npm: { name: "npm", url: "https://www.npmjs.com/search?q={query}" },
  mdn: {
    name: "MDN Web Docs",
    url: "https://developer.mozilla.org/en-US/search?q={query}",
  },
  codepen: { name: "CodePen", url: "https://codepen.io/search/pens?q={query}" },
  steam: {
    name: "Steam",
    url: "https://store.steampowered.com/search/?term={query}",
  },
  twitch: { name: "Twitch", url: "https://www.twitch.tv/search?term={query}" },
  notion: { name: "Notion", url: "https://www.notion.so/" },
  figma: {
    name: "Figma",
    url: "https://www.figma.com/search?model_type=files&q={query}",
  },
  slack: { name: "Slack", url: "https://slack.com/" },
  pinterest: {
    name: "Pinterest",
    url: "https://www.pinterest.com/search/pins/?q={query}",
  },
  snapchat: { name: "Snapchat", url: "https://www.snapchat.com/" },
  time: {
    name: "Current Time",
    url: "https://www.google.com/search?q=current+time+{query}",
  },
  calc: {
    name: "Calculator",
    url: "https://www.google.com/search?q=calculator+{query}",
  },
  define: {
    name: "Dictionary",
    url: "https://www.google.com/search?q=define+{query}",
  },
  convert: {
    name: "Unit Converter",
    url: "https://www.google.com/search?q=convert+{query}",
  },
  linkedin: {
    name: "LinkedIn",
    url: "https://www.linkedin.com/search/results/all/?keywords={query}",
  },
  medium: { name: "Medium", url: "https://medium.com/search?q={query}" },
  quora: { name: "Quora", url: "https://www.quora.com/search?q={query}" },
  archive: {
    name: "Internet Archive",
    url: "https://web.archive.org/web/*/{query}",
  },
  wayback: {
    name: "Wayback Machine",
    url: "https://web.archive.org/web/*/{query}",
  },
} as const;
