const CANONICAL_ICON_VARIANT = "round-outlined-radius-3-stroke-1.5" as const;
const SOLID_ICON_VARIANT = "solid-stroke-1.5-corner-medium" as const;
type CanonicalIconVariant = typeof CANONICAL_ICON_VARIANT;
type SolidIconVariant = typeof SOLID_ICON_VARIANT;

interface IconSource {
  viewBox: string;
  attributes: Readonly<Record<string, string>>;
  content: string;
  svg: string;
}

export interface IconPathData extends IconSource {
  name: string;
  variant: CanonicalIconVariant;
  solidVariant: SolidIconVariant;
  solid: IconSource;
}

const ROOT_STROKE_ATTRIBUTE_PATTERN =
  /\s(?:stroke|stroke-width|stroke-linecap|stroke-linejoin)="[^"]*"/g;
const DRAWING_ELEMENT_PATTERN =
  /<(?:path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)\/?>(?:<\/[^>]+>)?/g;
const DEFAULT_ICON_STROKE_WIDTH = 'stroke-width="1.5"';
const APP_ICON_STROKE_WIDTH = 'stroke-width="1.75"';

function createSource(svg: string): IconSource {
  const normalizedSvg = svg.replaceAll(
    DEFAULT_ICON_STROKE_WIDTH,
    APP_ICON_STROKE_WIDTH,
  );
  const openingEnd = normalizedSvg.indexOf(">", 4);
  const closingStart = normalizedSvg.lastIndexOf("</svg>");
  if (
    !normalizedSvg.startsWith("<svg") ||
    openingEnd < 0 ||
    closingStart <= openingEnd
  ) {
    throw new Error("invalid canonical icon source... /ᐠ - ˕ -マ");
  }
  const openingTag = normalizedSvg.slice(0, openingEnd + 1);
  const content = normalizedSvg.slice(openingEnd + 1, closingStart);
  const hasFilledOutline = [...content.matchAll(DRAWING_ELEMENT_PATTERN)].some(
    (match) =>
      /\bfill="currentColor"/.test(match[1]!) && !/\bstroke=/.test(match[1]!),
  );
  const normalizedOpeningTag = hasFilledOutline
    ? openingTag.replace(ROOT_STROKE_ATTRIBUTE_PATTERN, "")
    : openingTag;
  const attributes = Object.fromEntries(
    [
      ...normalizedOpeningTag.matchAll(
        /([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g,
      ),
    ].map((match) => [match[1]!, match[2]!]),
  );
  const viewBox = attributes["viewBox"];
  if (!viewBox) {
    throw new Error("canonical icon is missing a viewbox... /ᐠ - ˕ -マ");
  }
  return Object.freeze({
    viewBox,
    attributes: Object.freeze(attributes),
    content,
    svg: `${normalizedOpeningTag}${content}</svg>`,
  });
}

function createIcon(name: string, svg: string, solidSvg?: string): IconPathData {
  const source = createSource(svg);
  return Object.freeze({
    name,
    variant: CANONICAL_ICON_VARIANT,
    solidVariant: SOLID_ICON_VARIANT,
    ...source,
    solid: solidSvg ? createSource(solidSvg) : source,
  });
}

function createOutlineIcon(name: string, content: string): IconPathData {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
  return createIcon(name, svg);
}

export const ICON_PATHS = {
  IconArrowCornerUpLeft: createOutlineIcon(
    "IconArrowCornerUpLeft",
    '<path d="M20.25 19.25V10.75C20.25 9.64543 19.3546 8.75 18.25 8.75H4.75"/><path d="M7.75 12.75L3.75 8.75L7.75 4.75"/>',
  ),
  IconArrowRotateClockwise: createIcon(
    "IconArrowRotateClockwise",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 7.00891C16.6791 4.95438 14.7962 3.75 11.979 3.75C7.42266 3.75 3.729 7.44365 3.729 12C3.729 16.5563 7.42266 20.25 11.979 20.25C15.5711 20.25 18.627 17.9543 19.7596 14.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.25 4V8H15.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M4.47852 12C4.47852 7.85786 7.83638 4.5 11.9785 4.5C13.4412 4.5 14.601 4.85088 15.634 5.4849C16.3541 5.92693 17.0281 6.51595 17.7063 7.25H15.25C14.8358 7.25 14.5 7.58579 14.5 8C14.5 8.41421 14.8358 8.75 15.25 8.75H19.25C19.6642 8.75 20 8.41421 20 8V4C20 3.58579 19.6642 3.25 19.25 3.25C18.8358 3.25 18.5 3.58579 18.5 4V5.90758C17.8486 5.24074 17.166 4.66521 16.4186 4.20651C15.1414 3.42256 13.7085 3 11.9785 3C7.00795 3 2.97852 7.02944 2.97852 12C2.97852 16.9706 7.00795 21 11.9785 21C15.8983 21 19.2311 18.4945 20.4662 14.9999C20.6042 14.6094 20.3995 14.1809 20.009 14.0429C19.6185 13.9048 19.19 14.1095 19.0519 14.5001C18.022 17.4141 15.2429 19.5 11.9785 19.5C7.83638 19.5 4.47852 16.1421 4.47852 12Z" fill="currentColor"></path></svg>',
  ),
  IconCheckCircle2: createIcon(
    "IconCheckCircle2",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.75 12.9231L10.5625 15.75L15.25 8.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM15.667 8.12695C15.3228 7.89661 14.8574 7.98889 14.627 8.33301L10.4482 14.5723L8.28125 12.3945C7.98911 12.1009 7.51434 12.0995 7.2207 12.3916C6.92733 12.6838 6.9267 13.1586 7.21875 13.4521L10.0312 16.2793C10.1897 16.4384 10.4112 16.5177 10.6348 16.4961C10.8584 16.4744 11.0605 16.3537 11.1855 16.167L15.873 9.16699C16.1034 8.82283 16.0111 8.35739 15.667 8.12695Z" fill="currentColor"></path></svg>',
  ),
  IconArrowLeft: createIcon(
    "IconArrowLeft",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.75L3.75 12L10 18.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 12H20.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconChevronBottom: createIcon(
    "IconChevronBottom",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 9L14.1213 14.8787C12.9498 16.0503 11.0503 16.0503 9.8787 14.8787L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconArrowRight: createIcon(
    "IconArrowRight",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5.75L20.25 12L14 18.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.5 12H3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconCloud: createIcon(
    "IconCloud",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9948 11.002C17.9983 10.9184 18 10.8344 18 10.75C18 7.43629 15.3137 4.75 12 4.75C9.3716 4.75 7.13793 6.44009 6.32647 8.7928C3.74507 9.12339 1.75 11.3287 1.75 14C1.75 16.8995 4.10051 19.25 7 19.25H18.125C20.4032 19.25 22.25 17.4032 22.25 15.125C22.25 12.8468 20.4032 11 18.125 11C18.0814 11 18.038 11.0007 17.9948 11.002Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M12 4C9.20241 4 6.80396 5.70153 5.77996 8.12427C3.05102 8.68825 1 11.1041 1 14C1 17.3137 3.68629 20 7 20H18.125C20.8174 20 23 17.8174 23 15.125C23 12.639 21.1392 10.5876 18.7344 10.2877C18.4969 6.77542 15.5725 4 12 4Z" fill="currentColor"></path></svg>',
  ),
  IconGlobe: createIcon(
    "IconGlobe",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M12 21C9.79086 21 8 16.9706 8 12C8 7.02944 9.79086 3 12 3C14.2091 3 16 7.02944 16 12C16 16.9706 14.2091 21 12 21Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M21 12H3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>',
  ),
  IconFullScreen: createIcon(
    "IconFullScreen",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.25 3.75H6.75C5.09315 3.75 3.75 5.09315 3.75 6.75V8.25M15.75 3.75H17.25C18.9069 3.75 20.25 5.09315 20.25 6.75V8.25M20.25 15.75V17.25C20.25 18.9069 18.9069 20.25 17.25 20.25H15.75M8.25 20.25H6.75C5.09315 20.25 3.75 18.9069 3.75 17.25V15.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconVideoClip: createIcon(
    "IconVideoClip",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 12H7.75M3.75 12V7.875M3.75 12V16.125M7.75 12H16.25M7.75 12V16.125M7.75 12V7.875M16.25 12H20.25M16.25 12V16.5833M16.25 12V7.875M20.25 12V7.875M20.25 12V16.5833M16.25 20.25H17.25C18.9069 20.25 20.25 18.9069 20.25 17.25V16.5833M16.25 20.25V16.5833M16.25 20.25H7.75M16.25 3.75H17.25C18.9069 3.75 20.25 5.09315 20.25 6.75V7.875M16.25 3.75V7.875M16.25 3.75H7.75M16.25 7.875H20.25M16.25 16.5833H20.25M7.75 20.25H6.75C5.09315 20.25 3.75 18.9069 3.75 17.25V16.125M7.75 20.25V16.125M7.75 3.75H6.75C5.09315 3.75 3.75 5.09315 3.75 6.75V7.875M7.75 3.75V7.875M3.75 7.875H7.75M3.75 16.125H7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 5.75C3 4.23122 4.23122 3 5.75 3H18.25C19.7688 3 21 4.23122 21 5.75V18.25C21 19.7688 19.7688 21 18.25 21H5.75C4.23122 21 3 19.7688 3 18.25V5.75ZM5.75 4.5C5.05964 4.5 4.5 5.05964 4.5 5.75V7.125H7V4.5H5.75ZM17 4.5V7.125H19.5V5.75C19.5 5.05964 18.9404 4.5 18.25 4.5H17ZM19.5 8.625H17V11.25H19.5V8.625ZM19.5 12.75H17V15.8333H19.5V12.75ZM19.5 17.3333H17V19.5H18.25C18.9404 19.5 19.5 18.9404 19.5 18.25V17.3333ZM15.5 12.75V11.25H8.5V12.75H15.5ZM7 19.5V16.875H4.5V18.25C4.5 18.9404 5.05964 19.5 5.75 19.5H7ZM4.5 15.375H7V12.75H4.5V15.375ZM4.5 11.25H7V8.625H4.5V11.25Z" fill="currentColor"></path></svg>',
  ),
  IconGamecontroller: createIcon(
    "IconGamecontroller",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2027 4.75H10.7973C8.48821 4.75 7.33367 4.75 6.3836 5.16101C5.54568 5.5235 4.823 6.1085 4.29394 6.85255C3.69407 7.69619 3.45362 8.82541 2.97271 11.0839L2.02936 15.514C1.72348 16.9505 2.49631 18.3985 3.85994 18.944C5.34267 19.5371 7.03075 18.8722 7.71072 17.4272L7.92445 16.9731C8.27576 16.2265 9.02663 15.75 9.85171 15.75H14.1483C14.9734 15.75 15.7242 16.2265 16.0756 16.9731L16.2893 17.4272C16.9692 18.8722 18.6573 19.5371 20.1401 18.944C21.5037 18.3985 22.2765 16.9505 21.9706 15.514L21.0273 11.0839L21.0273 11.0838C20.5464 8.82541 20.3059 7.69619 19.7061 6.85255C19.177 6.1085 18.4543 5.5235 17.6164 5.16101C16.6663 4.75 15.5118 4.75 13.2027 4.75Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17.0008" cy="11.6502" r="1.2" fill="currentColor"/><circle cx="15.0008" cy="8.8499" r="1.2" fill="currentColor"/><path d="M10.2992 10.3H6.69922M8.49924 12.1L8.4992 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.205 4C14.3484 4 15.2466 3.99983 15.9765 4.05371C16.7158 4.1083 17.3342 4.22099 17.916 4.47266C18.8796 4.88952 19.7109 5.56232 20.3193 6.41797C20.6866 6.9346 20.9264 7.51581 21.1337 8.22754C21.3385 8.9303 21.5245 9.80925 21.7627 10.9277L22.8349 15.9609C23.1421 17.4034 22.4352 18.8716 21.1162 19.5312C19.4899 20.3444 17.5125 19.6597 16.7382 18.0146L16.2207 16.9131C16.1019 16.661 15.848 16.5002 15.5693 16.5H8.43453C8.15583 16.5001 7.90196 16.661 7.78316 16.9131L7.26558 18.0146C6.49132 19.6597 4.51388 20.3443 2.88765 19.5312C1.56862 18.8716 0.86174 17.4034 1.1689 15.9609L2.24117 10.9277C2.47934 9.80924 2.66534 8.93031 2.87007 8.22754C3.07744 7.5158 3.31719 6.9346 3.68453 6.41797C4.29294 5.56232 5.12424 4.88952 6.08785 4.47266C6.66963 4.221 7.28803 4.10829 8.0273 4.05371C8.7572 3.99984 9.65543 4 10.7988 4H13.205ZM17.0019 10.4502C16.3392 10.4502 15.8017 10.9876 15.8017 11.6504C15.8018 12.313 16.3392 12.8506 17.0019 12.8506C17.6645 12.8505 18.202 12.313 18.2021 11.6504C18.2021 10.9877 17.6646 10.4503 17.0019 10.4502ZM8.50191 7.75C8.08777 7.75009 7.75191 8.08584 7.75191 8.5V9.5498H6.7021C6.28796 9.5498 5.95221 9.88568 5.9521 10.2998C5.9521 10.714 6.28789 11.0498 6.7021 11.0498H7.75191V12.0996C7.75191 12.5137 8.0878 12.8495 8.50191 12.8496C8.91612 12.8496 9.25191 12.5138 9.25191 12.0996V11.0498H10.3017C10.7159 11.0498 11.0517 10.714 11.0517 10.2998C11.0516 9.88568 10.7159 9.5498 10.3017 9.5498H9.25191V8.5C9.2519 8.08579 8.91612 7.74999 8.50191 7.75ZM15.0019 7.65039C14.3393 7.65039 13.8019 8.187 13.8017 8.84961C13.8017 9.51235 14.3392 10.0498 15.0019 10.0498C15.6646 10.0497 16.2021 9.51229 16.2021 8.84961C16.2019 8.18707 15.6645 7.6505 15.0019 7.65039Z" fill="currentColor"></path></svg>',
  ),
  IconSettingsGear4: createIcon(
    "IconSettingsGear4",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M7.37506 3.98898C6.3995 4.55222 5.99767 5.75491 6.43871 6.79146L6.62174 7.22161C5.98033 7.94301 5.48186 8.79434 5.17077 9.73116L4.70884 9.78747C3.59064 9.92379 2.75 10.8731 2.75 11.9996C2.75 13.1261 3.59064 14.0754 4.70884 14.2117L5.1704 14.268C5.48144 15.2052 5.97999 16.0568 6.62157 16.7785L6.43873 17.2082C5.99769 18.2447 6.39952 19.4474 7.37508 20.0107C8.35064 20.5739 9.59311 20.3206 10.2703 19.4203L10.55 19.0484C11.0184 19.1442 11.5034 19.1946 12.0001 19.1946C12.4969 19.1946 12.9818 19.1442 13.4503 19.0484L13.7299 19.4201C14.407 20.3203 15.6495 20.5737 16.6251 20.0105C17.6006 19.4472 18.0025 18.2445 17.5614 17.208L17.3786 16.7785C18.0202 16.0568 18.5188 15.2052 18.8298 14.268L19.2912 14.2117C20.4094 14.0754 21.25 13.1261 21.25 11.9996C21.25 10.8731 20.4094 9.92379 19.2912 9.78747L18.8294 9.73119C18.7517 9.49698 18.6622 9.26812 18.5617 9.04529C18.2601 8.37679 17.8594 7.76262 17.3784 7.22156L17.5613 6.7916C18.0024 5.75506 17.6005 4.55237 16.625 3.98913C15.6494 3.42589 14.4069 3.67923 13.7298 4.57947L13.4497 4.95176C12.9815 4.85595 12.4967 4.8057 12.0001 4.8057C11.5035 4.8057 11.0187 4.85601 10.5504 4.95181L10.2702 4.57932C9.59309 3.67909 8.35062 3.42574 7.37506 3.98898Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.3291 3.87256C14.1654 2.89171 15.5633 2.60699 16.7168 3.18213C16.7984 3.2228 16.8849 3.27286 17 3.33936C17.1153 3.40591 17.2023 3.45605 17.2783 3.50635C18.353 4.21767 18.8051 5.57016 18.3741 6.78467C18.3435 6.87056 18.3031 6.96301 18.251 7.08545L18.2471 7.09326C18.6422 7.59558 18.979 8.14682 19.2451 8.73682C19.2903 8.83688 19.332 8.93927 19.3731 9.0415L19.3819 9.04346C19.5141 9.05957 19.6135 9.07088 19.7032 9.0874C20.9707 9.3211 21.9163 10.3888 21.9951 11.6753C22.0007 11.7662 22 11.8665 22 11.9995C22 12.1325 22.0007 12.2328 21.9951 12.3237C21.9166 13.6105 20.9709 14.6779 19.7032 14.9116C19.6134 14.9282 19.5141 14.9404 19.3819 14.9565H19.3741C19.0909 15.6621 18.7093 16.3168 18.2471 16.9048L18.252 16.9146C18.304 17.0367 18.3436 17.1286 18.3741 17.2144C18.8055 18.4291 18.3533 19.7822 17.2783 20.4937C17.2023 20.544 17.1153 20.5931 17 20.6597C16.8847 20.7263 16.7984 20.7772 16.7168 20.8179C15.5632 21.3931 14.1654 21.1075 13.3291 20.1265C13.2701 20.0572 13.2107 19.9767 13.1309 19.8706L13.125 19.8628C12.7571 19.915 12.3817 19.9448 12 19.9448C11.6184 19.9448 11.2429 19.916 10.875 19.8638L10.8701 19.8716C10.7901 19.9779 10.73 20.0581 10.6709 20.1274C9.83462 21.1085 8.43685 21.3932 7.28323 20.8179C7.20171 20.7772 7.1152 20.7271 7.00003 20.6606C6.88475 20.5941 6.79774 20.544 6.72171 20.4937C5.64693 19.7821 5.19552 18.429 5.62698 17.2144C5.65747 17.1286 5.69707 17.0367 5.74905 16.9146L5.75198 16.9048C5.28999 16.3169 4.90903 15.6619 4.626 14.9565H4.61819C4.48598 14.9404 4.3866 14.9282 4.2969 14.9116C3.02923 14.6778 2.08347 13.6104 2.00491 12.3237C1.99938 12.2328 2.00003 12.1325 2.00003 11.9995C2.00002 11.8665 1.99936 11.7662 2.00491 11.6753C2.08373 10.3888 3.02934 9.3211 4.2969 9.0874C4.38663 9.07086 4.48593 9.0586 4.61819 9.04248L4.626 9.04053C4.90915 8.33573 5.29109 7.68164 5.75296 7.09424L5.74905 7.08545C5.69697 6.96306 5.65748 6.87054 5.62698 6.78467C5.19577 5.57011 5.64699 4.21775 6.72171 3.50635C6.79776 3.45603 6.8847 3.40594 7.00003 3.33936C7.11525 3.27283 7.20168 3.22281 7.28323 3.18213C8.43675 2.60692 9.83463 2.89174 10.6709 3.87256C10.73 3.94184 10.7893 4.02229 10.8692 4.12842L10.875 4.13623C11.2429 4.08403 11.6184 4.05616 12 4.05615C12.3812 4.05615 12.7565 4.08415 13.124 4.13623L13.1309 4.12842C13.2107 4.02226 13.2701 3.94185 13.3291 3.87256ZM12 9.00049C10.3434 9.0006 9.00017 10.3438 9.00003 12.0005C9.00019 13.6571 10.3434 15.0004 12 15.0005C13.6568 15.0005 14.9999 13.6572 15 12.0005C14.9999 10.3438 13.6568 9.00049 12 9.00049Z" fill="currentColor"></path></svg>',
  ),
  IconGhost: createIcon(
    "IconGhost",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.75 9.94444V20.2023C4.75 20.9864 5.61121 21.4655 6.27736 21.052L6.97381 20.6197C7.84636 20.0781 8.93531 20.0205 9.86015 20.467L10.6958 20.8704C11.5198 21.2682 12.4802 21.2682 13.3042 20.8704L14.1399 20.467C15.0647 20.0205 16.1536 20.0781 17.0262 20.6197L17.7226 21.052C18.3888 21.4655 19.25 20.9864 19.25 20.2023V9.94444C19.25 5.97106 16.0041 2.75 12 2.75C7.99594 2.75 4.75 5.97106 4.75 9.94444Z" stroke="currentColor" stroke-width="1.5"/><path d="M10.25 10.5C10.25 10.9142 9.91421 11.25 9.5 11.25C9.08579 11.25 8.75 10.9142 8.75 10.5C8.75 10.0858 9.08579 9.75 9.5 9.75C9.91421 9.75 10.25 10.0858 10.25 10.5Z" stroke="currentColor" stroke-width="1.5"/><path d="M15.25 10.5C15.25 10.9142 14.9142 11.25 14.5 11.25C14.0858 11.25 13.75 10.9142 13.75 10.5C13.75 10.0858 14.0858 9.75 14.5 9.75C14.9142 9.75 15.25 10.0858 15.25 10.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
  ),
  IconHeart: createIcon(
    "IconHeart",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.25 9.9375C21.25 15.8672 12.7708 20.25 12 20.25C11.2292 20.25 2.75 15.8672 2.75 9.9375C2.75 5.8125 5.31944 3.75 7.88889 3.75C10.4583 3.75 12 5.29688 12 5.29688C12 5.29688 13.5417 3.75 16.1111 3.75C18.6806 3.75 21.25 5.8125 21.25 9.9375Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  ),
  IconFaceSmilePlus: createOutlineIcon(
    "IconFaceSmilePlus",
    '<path d="M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M19 1.75V8.25M15.75 5H22.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.75 9.9C10.75 11.0046 10.0784 11.75 9.25 11.75C8.42157 11.75 7.75 11.0046 7.75 9.9C7.75 8.79543 8.42157 8 9.25 8C10.0784 8 10.75 8.79543 10.75 9.9Z" fill="currentColor" stroke="none"/><path d="M16.25 9.9C16.25 11.0046 15.5784 11.75 14.75 11.75C13.9216 11.75 13.25 11.0046 13.25 9.9C13.25 8.79543 13.9216 8 14.75 8C15.5784 8 16.25 8.79543 16.25 9.9Z" fill="currentColor" stroke="none"/><path d="M16.1123 14.8493C16.1942 14.7105 16.2249 14.545 16.192 14.3857C16.1592 14.2263 16.0665 14.0867 15.933 13.9968C15.7996 13.9069 15.6354 13.8733 15.4754 13.9028C15.3154 13.9321 15.1736 14.0226 15.0757 14.1507C15.0008 14.2469 14.9237 14.3367 14.8415 14.4241C14.1096 15.2083 13.061 15.628 12.0035 15.625C10.946 15.6265 9.8972 15.2055 9.16254 14.4222C9.08002 14.3348 9.00261 14.2451 8.92738 14.1491C8.8291 14.0214 8.68699 13.9313 8.52686 13.9024C8.36679 13.8735 8.20268 13.9076 8.06954 13.9979C7.9364 14.0882 7.84406 14.2281 7.81174 14.3875C7.77938 14.547 7.81054 14.7123 7.89293 14.8509C7.97731 14.99 8.06686 15.1223 8.16553 15.2526C9.04297 16.4311 10.5292 17.1343 12.0024 17.125C13.4754 17.1367 14.965 16.4342 15.8405 15.2521C15.939 15.1215 16.0282 14.9888 16.1123 14.8493Z" fill="currentColor" stroke="none"/>',
  ),
  IconHomeOpen: createIcon(
    "IconHomeOpen",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.0197 3.4903L9.52457 2.92693L10.0197 3.4903ZM19.2303 8.10394L19.7254 7.54056L19.2303 8.10394ZM4.76966 8.10394L4.27457 7.54057L4.76966 8.10394ZM19.5 10.3574V17.25H21V10.3574H19.5ZM4.5 17.25V10.3574H3V17.25H4.5ZM5.26474 8.66731L10.5147 4.05368L9.52457 2.92693L4.27457 7.54057L5.26474 8.66731ZM13.4853 4.05368L18.7353 8.66731L19.7254 7.54056L14.4754 2.92693L13.4853 4.05368ZM13.5 17V19.25H15V17H13.5ZM10.5 19.25V17H9V19.25H10.5ZM8.75 19.5H6.75V21H8.75V19.5ZM15.25 21H17.25V19.5H15.25V21ZM9 19.25C9 19.3881 8.88807 19.5 8.75 19.5V21C9.7165 21 10.5 20.2165 10.5 19.25H9ZM13.5 19.25C13.5 20.2165 14.2835 21 15.25 21V19.5C15.1119 19.5 15 19.3881 15 19.25H13.5ZM12 15.5C12.8284 15.5 13.5 16.1716 13.5 17H15C15 15.3431 13.6569 14 12 14V15.5ZM12 14C10.3431 14 9 15.3431 9 17H10.5C10.5 16.1716 11.1716 15.5 12 15.5V14ZM10.5147 4.05368C11.3642 3.30717 12.6358 3.30717 13.4853 4.05368L14.4754 2.92693C13.0596 1.68275 10.9404 1.68275 9.52457 2.92693L10.5147 4.05368ZM3 17.25C3 19.3211 4.67893 21 6.75 21V19.5C5.50736 19.5 4.5 18.4926 4.5 17.25H3ZM19.5 17.25C19.5 18.4926 18.4926 19.5 17.25 19.5V21C19.3211 21 21 19.3211 21 17.25H19.5ZM21 10.3574C21 9.27887 20.5356 8.25254 19.7254 7.54056L18.7353 8.66731C19.2214 9.0945 19.5 9.7103 19.5 10.3574H21ZM4.5 10.3574C4.5 9.7103 4.77864 9.0945 5.26474 8.66731L4.27457 7.54057C3.4644 8.25254 3 9.27887 3 10.3574H4.5Z" fill="currentColor"/></svg>',
  ),
  IconImageAltText: createIcon(
    "IconImageAltText",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.75 17.25H12.25M15.25 17.25H17.25M20.25 14.25V6.75C20.25 5.09315 18.9069 3.75 17.25 3.75H6.75C5.09315 3.75 3.75 5.09315 3.75 6.75V12.0577M20.25 14.25V17.25C20.25 18.9069 18.9069 20.25 17.25 20.25H6.75C5.09315 20.25 3.75 18.9069 3.75 17.25V14.25M20.25 14.25H14.2767M3.75 14.25V12.0577M3.75 14.25H14.2767M3.75 12.0577L5.80016 9.95496C6.97827 8.74664 8.92087 8.74747 10.098 9.9568L14.2767 14.25M17.25 8.25C17.25 9.07843 16.5784 9.75 15.75 9.75C14.9216 9.75 14.25 9.07843 14.25 8.25C14.25 7.42157 14.9216 6.75 15.75 6.75C16.5784 6.75 17.25 7.42157 17.25 8.25Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconChainLink4: createIcon(
    "IconChainLink4",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 19.0004L9.82843 19.1719C8.26634 20.734 5.73368 20.734 4.17158 19.1719L3.82843 18.8288C2.26634 17.2667 2.26633 14.734 3.82843 13.1719L7.17158 9.8288C8.73368 8.2667 11.2663 8.2667 12.8284 9.8288L13.1716 10.1719C13.8252 10.8256 14.2053 11.6491 14.312 12.5004" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.68799 12.5004C9.79463 13.3516 10.1748 14.1752 10.8284 14.8288L11.1715 15.1719C12.7336 16.734 15.2663 16.734 16.8284 15.1719L20.1715 11.8288C21.7336 10.2667 21.7336 7.73404 20.1715 6.17194L19.8284 5.8288C18.2663 4.2667 15.7336 4.2667 14.1715 5.8288L14 6.00037" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconMagnifyingGlass2: createIcon(
    "IconMagnifyingGlass2",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20L16.1265 16.1265M16.1265 16.1265C17.4385 14.8145 18.25 13.002 18.25 11C18.25 6.99594 15.0041 3.75 11 3.75C6.99594 3.75 3.75 6.99594 3.75 11C3.75 15.0041 6.99594 18.25 11 18.25C13.002 18.25 14.8145 18.25 16.1265 16.1265Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconAudio: createIcon(
    "IconAudio",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.75 18.75C9.75 20.1307 8.40685 21.25 6.75 21.25C5.09315 21.25 3.75 20.1307 3.75 18.75C3.75 17.3692 5.09315 16.25 6.75 16.25C8.40685 16.25 9.75 17.3692 9.75 18.75ZM9.75 18.75V8.013C9.75 6.67349 10.638 5.4963 11.926 5.12838L16.4282 3.84231C18.3446 3.29487 20.2522 4.73385 20.2522 6.72692V15.75M20.2522 15.75C20.2522 17.1307 18.9091 18.25 17.2522 18.25C15.5953 18.25 14.2522 17.1307 14.2522 15.75C14.2522 14.3692 15.5953 13.25 17.2522 13.25C18.9091 13.25 20.2522 14.3692 20.2522 15.75Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  ),
  IconColorPalette: createIcon(
    "IconColorPalette",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.25 12C21.25 19.1094 13.6572 12.7979 12 16.1176C10.9722 18.1765 14.9058 20.75 12 20.75C6.89137 20.75 2.75 16.8325 2.75 12C2.75 7.16751 6.89137 3.25 12 3.25C17.1086 3.25 21.25 7.16751 21.25 12Z" stroke="currentColor" stroke-width="1.5"/><path d="M11.5 7.75C11.5 8.44036 10.9404 9 10.25 9C9.55964 9 9 8.44036 9 7.75C9 7.05964 9.55964 6.5 10.25 6.5C10.9404 6.5 11.5 7.05964 11.5 7.75Z" stroke="currentColor" stroke-width="1.5"/><path d="M8.5 12C8.5 12.6904 7.94036 13.25 7.25 13.25C6.55964 13.25 6 12.6904 6 12C6 11.3096 6.55964 10.75 7.25 10.75C7.94036 10.75 8.5 11.3096 8.5 12Z" stroke="currentColor" stroke-width="1.5"/><path d="M16.5 9.25C16.5 9.94036 15.9404 10.5 15.25 10.5C14.5596 10.5 14 9.94036 14 9.25C14 8.55964 14.5596 8 15.25 8C15.9404 8 16.5 8.55964 16.5 9.25Z" stroke="currentColor" stroke-width="1.5"/></svg>',
  ),
  IconPencil: createIcon(
    "IconPencil",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.25 6.24997L15.25 4.24997C16.4926 3.00733 18.5074 3.00733 19.75 4.24997C20.9926 5.49261 20.9926 7.50733 19.75 8.74997L17.75 10.75L7.83579 20.6642C7.46071 21.0393 6.95201 21.25 6.42157 21.25H2.75V17.5784C2.75 17.048 2.96071 16.5393 3.33579 16.1642L13.25 6.24997Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.25 6.25L17.75 10.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconPlusMedium: createIcon(
    "IconPlusMedium",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.25V12M12 12V18.75M12 12H5.25M12 12H18.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  ),
  IconPuzzle: createIcon(
    "IconPuzzle",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 7.75C3.75 6.09315 5.09315 4.75 6.75 4.75H9.25V4.5C9.25 2.98122 10.4812 1.75 12 1.75C13.5188 1.75 14.75 2.98122 14.75 4.5V4.75H17.25C18.9069 4.75 20.25 6.09315 20.25 7.75V9.25H20C18.4812 9.25 17.25 10.4812 17.25 12C17.25 13.5188 18.4812 14.75 20 14.75H20.25V16.25C20.25 17.9069 18.9069 19.25 17.25 19.25H6.75C5.09315 19.25 3.75 17.9069 3.75 16.25V7.75Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round"/></svg>',
  ),
  IconBubbleText: createIcon(
    "IconBubbleText",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.25 9H8.75M15.25 13H8.75M9.29422 18.4836L11.3593 20.2147C11.7292 20.5248 12.2679 20.5263 12.6397 20.2183L14.738 18.4799C14.9173 18.3313 15.143 18.25 15.3759 18.25H17.25C18.9069 18.25 20.25 16.9069 20.25 15.25V6.75C20.25 5.09315 18.9069 3.75 17.25 3.75H6.75C5.09315 3.75 3.75 5.09315 3.75 6.75V15.25C3.75 16.9069 5.09315 18.25 6.75 18.25H8.65182C8.88675 18.25 9.11418 18.3327 9.29422 18.4836Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconChat: createIcon(
    "IconChat",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.25 9.75H8.75M12.25 14.25H8.75M2.75 20.25H16.25C19.0114 20.25 21.25 18.0114 21.25 15.25V8.75C21.25 5.98858 19.0114 3.75 16.25 3.75H7.75C4.98858 3.75 2.75 5.98858 2.75 8.75V20.25Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 21H16.25A5.75 5.75 0 0 0 22 15.25V8.75A5.75 5.75 0 0 0 16.25 3H7.75A5.75 5.75 0 0 0 2 8.75V21ZM8.75 9C8.33579 9 8 9.33579 8 9.75C8 10.1642 8.33579 10.5 8.75 10.5H15.25C15.6642 10.5 16 10.1642 16 9.75C16 9.33579 15.6642 9 15.25 9H8.75ZM8.75 13.5C8.33579 13.5 8 13.8358 8 14.25C8 14.6642 8.33579 15 8.75 15H12.25C12.6642 15 13 14.6642 13 14.25C13 13.8358 12.6642 13.5 12.25 13.5H8.75Z" fill="currentColor"></path></svg>',
  ),
  IconBook: createIcon(
    "IconBook",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.25 12V14.75C19.25 15.8546 18.3546 16.75 17.25 16.75H7C5.75736 16.75 4.75 17.7574 4.75 19C4.75 20.2426 5.75736 21.25 7 21.25H10M8.75 7H15.25M8.75 11H12.25M6.75 2.75H17.25C18.3546 2.75 19.25 3.64543 19.25 4.75V19.25C19.25 20.3546 18.3546 21.25 17.25 21.25H6.75C5.64543 21.25 4.75 20.3546 4.75 19.25V4.75C4.75 3.64543 5.64543 2.75 6.75 2.75Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconSettingsSliderHor: createIcon(
    "IconSettingsSliderHor",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path fill-rule="evenodd" clip-rule="evenodd" d="M9 20C10.7956 20 12.25 18.5456 12.25 16.75C12.25 14.9544 10.7956 13.5 9 13.5C7.20438 13.5 5.75 14.9544 5.75 16.75C5.75 18.5456 7.20438 20 9 20Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path fill-rule="evenodd" clip-rule="evenodd" d="M15 10.5C16.7956 10.5 18.25 9.04562 18.25 7.25C18.25 5.45438 16.7956 4 15 4C13.2044 4 11.75 5.45438 11.75 7.25C11.75 9.04562 13.2044 10.5 15 10.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M11.5 7.25H3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M5.5 16.75H3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M20.25 7.25H18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M20.25 16.75H12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>',
  ),
  IconCode: createIcon(
    "IconCode",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.25 7.75L20.605 11.3146C20.9674 11.6997 20.9674 12.3003 20.605 12.6854L17.25 16.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M6.75 16.25L3.39505 12.6854C3.03265 12.3003 3.03265 11.6997 3.39505 11.3146L6.75 7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  ),
  IconSushi: createIcon(
    "IconSushi",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.925 11.0442C4.76647 12.2911 1.75 16.1807 1.75 12.3631C1.75 8.54547 5.34147 5.62431 9.5 4.75M15.075 11.0442C19.2335 12.2911 22.25 16.1807 22.25 12.3631C22.25 8.54547 18.6585 5.62431 14.5 4.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.25 19.25V6.42241C9.25 5.04566 10.1903 3.80724 11.5661 3.75777C11.7099 3.7526 11.8546 3.75 12 3.75C12.1454 3.75 12.2901 3.7526 12.4339 3.75777C13.8097 3.80724 14.75 5.04566 14.75 6.42241V19.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.75 14V17.25C3.75 18.3546 4.64543 19.25 5.75 19.25C9.91667 19.25 14.0833 19.25 18.25 19.25C19.3546 19.25 20.25 18.3546 20.25 17.25V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconSplit: createIcon(
    "IconSplit",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.75V21.25M8.25 4.75H5.75C4.09315 4.75 2.75 6.09315 2.75 7.75V16.25C2.75 17.9069 4.09315 19.25 5.75 19.25H8.25M15.75 19.25H18.25C19.9069 19.25 21.25 17.9069 21.25 16.25V7.75C21.25 6.09315 19.9069 4.75 18.25 4.75H15.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconSidebar: createIcon(
    "IconSidebar",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.25 4.75H5.75C4.09315 4.75 2.75 6.09315 2.75 7.75V16.25C2.75 17.9069 4.09315 19.25 5.75 19.25H11.25M11.25 4.75H18.25C19.9069 4.75 21.25 6.09315 21.25 7.75V16.25C21.25 17.9069 19.9069 19.25 18.25 19.25H11.25M11.25 4.75V19.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round"/><path d="M6.25 8.5C6.25 8.91421 6.58579 9.25 7 9.25C7.41421 9.25 7.75 8.91421 7.75 8.5C7.75 8.08579 7.41421 7.75 7 7.75C6.58579 7.75 6.25 8.08579 6.25 8.5ZM6.25 12C6.25 12.4142 6.58579 12.75 7 12.75C7.41421 12.75 7.75 12.4142 7.75 12C7.75 11.5858 7.41421 11.25 7 11.25C6.58579 11.25 6.25 11.5858 6.25 12ZM6.25 15.5C6.25 15.9142 6.58579 16.25 7 16.25C7.41421 16.25 7.75 15.9142 7.75 15.5C7.75 15.0858 7.41421 14.75 7 14.75C6.58579 14.75 6.25 15.0858 6.25 15.5Z" fill="currentColor" stroke="currentColor" stroke-width="0.5"/></svg>',
  ),
  IconCrossMedium: createIcon(
    "IconCrossMedium",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.25 6.25L17.75 17.75M17.75 6.25L6.25 17.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  ),
  IconEyeOpen: createIcon(
    "IconEyeOpen",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.2742 10.685C16.4537 2.77174 7.54646 2.77164 2.72595 10.6849C2.23523 11.4904 2.23523 12.5094 2.72595 13.3149C7.54646 21.2282 16.4537 21.2283 21.2742 13.3151C21.7649 12.5095 21.7649 11.4905 21.2742 10.685Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.25 12C15.25 13.7949 13.7949 15.25 12 15.25C10.2051 15.25 8.75 13.7949 8.75 12C8.75 10.2051 10.2051 8.75 12 8.75C13.7949 8.75 15.25 10.2051 15.25 12Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconEyeSlash: createIcon(
    "IconEyeSlash",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.38159 5.13889C13.3878 3.93307 17.7647 5.53139 20.7882 9.93379C21.1633 10.4799 21.3509 10.753 21.4814 11.2848C21.57 11.6457 21.57 12.3543 21.4814 12.7152C21.3509 13.247 21.1633 13.52 20.7883 14.0661C20.4438 14.5678 20.0817 15.033 19.7046 15.4619" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 9.92322C9.03166 10.4864 8.75 11.2103 8.75 12C8.75 13.7949 10.2051 15.25 12 15.25C12.8035 15.25 13.5389 14.9584 14.1061 14.4753" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.22301 6.75C5.12982 7.56322 4.11098 8.62442 3.21183 9.93363C2.83668 10.4799 2.64911 10.753 2.51857 11.2848C2.42999 11.6457 2.43003 12.3545 2.51865 12.7154C2.64926 13.2472 2.83714 13.5207 3.2129 14.0677C6.8927 19.4243 12.5765 20.6283 17.1571 17.6795" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.75 2.75L21.25 21.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconCircleInfo: createIcon(
    "IconCircleInfo",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.75 11H12L12 16.25M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.375C11.6548 7.375 11.375 7.65482 11.375 8C11.375 8.34518 11.6548 8.625 12 8.625C12.3452 8.625 12.625 8.34518 12.625 8C12.625 7.65482 12.3452 7.375 12 7.375Z" fill="currentColor" stroke="currentColor" stroke-width="0.25"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM10 11C10 10.5858 10.3358 10.25 10.75 10.25H12C12.4142 10.25 12.75 10.5858 12.75 11L12.75 16.25C12.75 16.6642 12.4142 17 12 17C11.5858 17 11.25 16.6642 11.25 16.25L11.25 11.75H10.75C10.3358 11.75 10 11.4142 10 11ZM12 7.25C11.5858 7.25 11.25 7.58579 11.25 8C11.25 8.41421 11.5858 8.75 12 8.75C12.4142 8.75 12.75 8.41421 12.75 8C12.75 7.58579 12.4142 7.25 12 7.25Z" fill="currentColor"></path></svg>',
  ),
  IconExclamationTriangle: createIcon(
    "IconExclamationTriangle",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.74986V12.7499M12 15.4999V15.4899M9.44847 4.37571L3.08105 14.672C1.84507 16.6706 3.28264 19.2499 5.63256 19.2499H18.3674C20.7173 19.2499 22.1549 16.6706 20.9189 14.672L14.5515 4.3757C13.3789 2.47958 10.6211 2.47958 9.44847 4.37571ZM12.25 15.4999C12.25 15.6379 12.1381 15.7499 12 15.7499C11.8619 15.7499 11.75 15.6379 11.75 15.4999C11.75 15.3618 11.8619 15.2499 12 15.2499C12.1381 15.2499 12.25 15.3618 12.25 15.4999Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.63618 3.25763C10.7021 1.46491 13.2977 1.4649 14.3636 3.25763L21.8476 15.8443C22.9376 17.6774 21.6165 19.9998 19.4839 19.9998H4.51593C2.38326 19.9998 1.06225 17.6774 2.15221 15.8443L9.63618 3.25763ZM12 7.99976C12.4142 7.99976 12.75 8.33554 12.75 8.74976V12.7498C12.75 13.164 12.4142 13.4998 12 13.4998C11.5858 13.4998 11.25 13.164 11.25 12.7498V8.74976C11.25 8.33554 11.5858 7.99976 12 7.99976ZM13 15.4998C13 16.052 12.5523 16.4998 12 16.4998C11.4477 16.4998 11 16.052 11 15.4998C11 14.9475 11.4477 14.4998 12 14.4998C12.5523 14.4998 13 14.9475 13 15.4998Z" fill="currentColor"></path></svg>',
  ),
  IconPlay: createIcon(
    "IconPlay",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.9016 9.48786L10.3899 3.2788C8.39443 1.97623 5.75 3.40798 5.75 5.79094V18.2091C5.75 20.592 8.39442 22.0238 10.3899 20.7212L19.9016 14.5121C21.7151 13.3283 21.7151 10.6717 19.9016 9.48786Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  ),
  IconPause: createIcon(
    "IconPause",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.75 6C4.75 4.75736 5.75736 3.75 7 3.75C8.24264 3.75 9.25 4.75736 9.25 6V18C9.25 19.2426 8.24264 20.25 7 20.25C5.75736 20.25 4.75 19.2426 4.75 18V6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14.75 6C14.75 4.75736 15.7574 3.75 17 3.75C18.2426 3.75 19.25 4.75736 19.25 6V18C19.25 19.2426 18.2426 20.25 17 20.25C15.7574 20.25 14.75 19.2426 14.75 18V6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  ),
  IconVolumeFull: createIcon(
    "IconVolumeFull",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.2478 4.75194C21.1027 6.60683 22.25 9.16933 22.25 11.9998C22.25 14.8302 21.1027 17.3927 19.2478 19.2476M15.8891 8.11132C16.8844 9.10662 17.5 10.4816 17.5 12.0004C17.5 13.5192 16.8844 14.8942 15.8891 15.8895M3.75 7.74999H5.29844C5.75258 7.74999 6.1932 7.59543 6.54783 7.31173L10.6253 4.04974C11.2801 3.52593 12.25 3.99211 12.25 4.83061V19.1694C12.25 20.0079 11.2801 20.474 10.6253 19.9502L6.54783 16.6883C6.1932 16.4045 5.75258 16.25 5.29844 16.25H3.75C2.64543 16.25 1.75 15.3546 1.75 14.25V9.74999C1.75 8.64542 2.64543 7.74999 3.75 7.74999Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconVolumeHalf: createIcon(
    "IconVolumeHalf",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.8891 8.11132C16.8844 9.10662 17.5 10.4816 17.5 12.0004C17.5 13.5192 16.8844 14.8942 15.8891 15.8895M3.75 7.74999H5.29844C5.75258 7.74999 6.1932 7.59543 6.54783 7.31173L10.6253 4.04974C11.2801 3.52593 12.25 3.99211 12.25 4.83061V19.1694C12.25 20.0079 11.2801 20.474 10.6253 19.9502L6.54783 16.6883C6.1932 16.4045 5.75258 16.25 5.29844 16.25H3.75C2.64543 16.25 1.75 15.3546 1.75 14.25V9.74999C1.75 8.64542 2.64543 7.74999 3.75 7.74999Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconVolumeMinimum: createIcon(
    "IconVolumeMinimum",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.4648 9.99999C15.8052 10.5883 16 11.2714 16 12C16 12.7286 15.8052 13.4117 15.4648 14.0001M3.75 7.74999H5.29844C5.75258 7.74999 6.1932 7.59543 6.54783 7.31173L10.6253 4.04974C11.2801 3.52593 12.25 3.99211 12.25 4.83061V19.1694C12.25 20.0079 11.2801 20.474 10.6253 19.9502L6.54783 16.6883C6.1932 16.4045 5.75258 16.25 5.29844 16.25H3.75C2.64543 16.25 1.75 15.3546 1.75 14.25V9.74999C1.75 8.64542 2.64543 7.74999 3.75 7.74999Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  ),
  IconVolumeOff: createIcon(
    "IconVolumeOff",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 9.99999L19.3787 12.1213M19.3787 12.1213L17.2574 14.2426M19.3787 12.1213L17.2574 9.99999M19.3787 12.1213L21.5 14.2426M3.75 7.74999H5.29844C5.75258 7.74999 6.1932 7.59543 6.54783 7.31173L10.6253 4.04974C11.2801 3.52593 12.25 3.99211 12.25 4.83061V19.1694C12.25 20.0079 11.2801 20.474 10.6253 19.9502L6.54783 16.6883C6.1932 16.4045 5.75258 16.25 5.29844 16.25H3.75C2.64543 16.25 1.75 15.3546 1.75 14.25V9.74999C1.75 8.64542 2.64543 7.74999 3.75 7.74999Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  ),
  IconBack10s: createIcon(
    "IconBack10s",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.35057 9.25C5.3 6 8.541 3.75 12.0053 3.75C15.4998 3.75 18.4872 6.02978 19.6917 9.25M3.75 4.75V9.25H8.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.66406 20.1558V13.9858H7.62598L6.75635 14.6016C6.4834 14.7793 6.32471 14.8364 6.14062 14.8364C5.7915 14.8364 5.53125 14.5762 5.53125 14.2271C5.53125 13.9604 5.69629 13.7256 6.02002 13.5098L7.15625 12.7163C7.61328 12.4053 7.9751 12.2783 8.33057 12.2783C8.94629 12.2783 9.35889 12.7036 9.35889 13.3447V20.1558C9.35889 20.7397 9.04785 21.0762 8.5083 21.0762C7.9751 21.0762 7.66406 20.7334 7.66406 20.1558Z" fill="currentColor"/><path d="M10.8569 16.8804V16.4741C10.8569 13.8716 12.1011 12.1704 14.1641 12.1704C16.2334 12.1704 17.4521 13.8525 17.4521 16.4741V16.8804C17.4521 19.4766 16.1953 21.1841 14.1387 21.1841C12.082 21.1841 10.8569 19.4956 10.8569 16.8804ZM12.5708 16.4805V16.8677C12.5708 18.6958 13.1675 19.7876 14.1514 19.7876C15.1353 19.7876 15.7319 18.6958 15.7319 16.8677V16.4805C15.7319 14.6587 15.1353 13.5669 14.1514 13.5669C13.1675 13.5669 12.5708 14.6523 12.5708 16.4805Z" fill="currentColor"/></svg>',
  ),
  IconForwards10s: createIcon(
    "IconForwards10s",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.6497 9.25C18.7003 6 15.4593 3.75 11.995 3.75C8.50046 3.75 5.5131 6.02978 4.30859 9.25M19.6497 9.25H20.2503V4.75M19.6497 9.25H15.7503" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.16406 20.1558V13.9858H8.12598L7.25635 14.6016C6.9834 14.7793 6.82471 14.8364 6.64062 14.8364C6.2915 14.8364 6.03125 14.5762 6.03125 14.2271C6.03125 13.9604 6.19629 13.7256 6.52002 13.5098L7.65625 12.7163C8.11328 12.4053 8.4751 12.2783 8.83057 12.2783C9.44629 12.2783 9.85889 12.7036 9.85889 13.3447V20.1558C9.85889 20.7397 9.54785 21.0762 9.0083 21.0762C8.4751 21.0762 8.16406 20.7334 8.16406 20.1558Z" fill="currentColor"/><path d="M11.3569 16.8804V16.4741C11.3569 13.8716 12.6011 12.1704 14.6641 12.1704C16.7334 12.1704 17.9521 13.8525 17.9521 16.4741V16.8804C17.9521 19.4766 16.6953 21.1841 14.6387 21.1841C12.582 21.1841 11.3569 19.4956 11.3569 16.8804ZM13.0708 16.4805V16.8677C13.0708 18.6958 13.6675 19.7876 14.6514 19.7876C15.6353 19.7876 16.2319 18.6958 16.2319 16.8677V16.4805C16.2319 14.6587 15.6353 13.5669 14.6514 13.5669C13.6675 13.5669 13.0708 14.6523 13.0708 16.4805Z" fill="currentColor"/></svg>',
  ),
  IconDownsize: createIcon(
    "IconDownsize",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 9.25H6.25C7.90685 9.25 9.25 7.90685 9.25 6.25V3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.25 9.25H17.75C16.0931 9.25 14.75 7.90685 14.75 6.25V3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.75 20.25V17.75C14.75 16.0931 16.0931 14.75 17.75 14.75H20.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.75 14.75H6.25C7.90685 14.75 9.25 16.0931 9.25 17.75V20.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconHammer2: createIcon(
    "IconHammer2",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.75 10.25L4.25 16.75C3.42157 17.5784 3.42157 18.9216 4.25 19.75C5.07843 20.5784 6.42157 20.5784 7.25 19.75L13.75 13.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.75 10.25L13.75 13.25L14.5638 13.0819C15.5965 12.8685 16.5648 13.6572 16.5648 14.7118C16.8717 15.019 17.0252 15.1726 17.1942 15.2481C17.4536 15.3639 17.7501 15.3639 18.0096 15.2481C18.1786 15.1726 18.332 15.019 18.6389 14.7118L20.713 12.6353C21.0215 12.3265 21.1757 12.1721 21.251 12.0018C21.3651 11.744 21.3651 11.4501 21.251 11.1924C21.1757 11.0221 21.0214 10.8677 20.713 10.5589H19.6759C19.4565 10.3391 19.2145 10.1296 19.0322 9.8772C18.4085 9.01363 18.875 7.97128 18.3777 7.07549C18.3126 6.95813 18.2567 6.88241 18.1449 6.73095C15.6436 3.34234 12.2971 2.21719 8.19285 2.97641C7.93397 3.0243 7.75 3.25303 7.75 3.51631C7.75 3.71841 7.86018 3.90406 8.03383 4.00744C10.5508 5.50591 11.2924 7.22105 10.75 10.25Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconPaintBrush: createIcon(
    "IconPaintBrush",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.25 10.75V3.75C19.25 3.19772 18.8023 2.75 18.25 2.75H11.5L10 4.75L8.5 2.75H5.75C5.19772 2.75 4.75 3.19771 4.75 3.75V10.75C4.75 12.4069 6.09315 13.75 7.75 13.75H9.75L9.42705 18.7557C9.33117 20.2419 10.5107 21.5 12 21.5C13.4893 21.5 14.6688 20.2419 14.5729 18.7557L14.25 13.75H16.25C17.9069 13.75 19.25 12.4069 19.25 10.75Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.75 10.25H19.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  IconMegaphone: createOutlineIcon(
    "IconMegaphone",
    '<path d="M18.2461 14C19.9029 14 21.2461 12.6569 21.2461 11C21.2461 9.34315 19.9029 8 18.2461 8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M18.2461 5.4606V16.5393C18.2461 17.8857 16.9426 18.8475 15.6561 18.4502L4.15607 14.8995C3.31782 14.6407 2.74609 13.8659 2.74609 12.9886V9.01129C2.74609 8.134 3.31782 7.35912 4.15607 7.1003L15.6561 3.54961C16.9426 3.1524 18.2461 4.11418 18.2461 5.4606Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M12.5754 18.25C12.1636 19.4152 11.0523 20.25 9.74609 20.25C8.08924 20.25 6.74609 18.9069 6.74609 17.25V15.75" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M6.75 6.25V15.75" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path>',
  ),
  IconPeople: createOutlineIcon(
    "IconPeople",
    '<path d="M9 11.25C10.7949 11.25 12.25 9.79493 12.25 8C12.25 6.20507 10.7949 4.75 9 4.75C7.20507 4.75 5.75 6.20507 5.75 8C5.75 9.79493 7.20507 11.25 9 11.25Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M2.75 19.25C2.75 16.4886 4.98858 14.25 7.75 14.25H10.25C13.0114 14.25 15.25 16.4886 15.25 19.25" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M15.25 11.25C17.0449 11.25 18.5 9.79493 18.5 8C18.5 6.20507 17.0449 4.75 15.25 4.75" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M17.75 14.25C19.683 14.25 21.25 15.817 21.25 17.75V19.25" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path>',
  ),
  IconScreenPlay: createOutlineIcon(
    "IconScreenPlay",
    '<path d="M5.75 4.75H18.25C19.3546 4.75 20.25 5.64543 20.25 6.75V15.25C20.25 16.3546 19.3546 17.25 18.25 17.25H5.75C4.64543 17.25 3.75 16.3546 3.75 15.25V6.75C3.75 5.64543 4.64543 4.75 5.75 4.75Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M8.75 20.25H15.25" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path><path d="M10.75 8.95V13.05C10.75 13.4 11.13 13.62 11.43 13.44L14.85 11.39C15.14 11.21 15.14 10.79 14.85 10.61L11.43 8.56C11.13 8.38 10.75 8.6 10.75 8.95Z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"></path>',
  ),
} as const;

export type CanonicalIconName = keyof typeof ICON_PATHS;
