import IconBase from "./IconBase";
import type { JSX } from "preact";
import { ICON_PATHS, type CanonicalIconName } from "./paths";
import type { IconProps } from "./IconBase";

type IconComponent = (props: IconProps) => JSX.Element;

function makeIcon(name: CanonicalIconName): IconComponent {
  const icon = ICON_PATHS[name];
  return ({ size, solid, class: className, style, onClick }) => (
    <IconBase
      icon={icon}
      size={size}
      solid={solid}
      class={className}
      style={style}
      onClick={onClick}
    />
  );
}

export const IconArrowRotateClockwise = makeIcon("IconArrowRotateClockwise");
export const IconCheckCircle2 = makeIcon("IconCheckCircle2");
export const IconChevronBottom = makeIcon("IconChevronBottom");
export const IconArrowLeft = makeIcon("IconArrowLeft");
export const IconArrowCornerUpLeft = makeIcon("IconArrowCornerUpLeft");
export const IconArrowRight = makeIcon("IconArrowRight");
export const IconCloud = makeIcon("IconCloud");
export const IconFullScreen = makeIcon("IconFullScreen");
export const IconVideoClip = makeIcon("IconVideoClip");
export const IconGamecontroller = makeIcon("IconGamecontroller");
export const IconHammer2 = makeIcon("IconHammer2");
export const IconSettingsGear4 = makeIcon("IconSettingsGear4");
export const IconGhost = makeIcon("IconGhost");
export const IconHeart = makeIcon("IconHeart");
export const IconHomeOpen = makeIcon("IconHomeOpen");
export const IconChainLink4 = makeIcon("IconChainLink4");
export const IconMagnifyingGlass2 = makeIcon("IconMagnifyingGlass2");
export const IconAudio = makeIcon("IconAudio");
export const IconColorPalette = makeIcon("IconColorPalette");
export const IconPaintBrush = makeIcon("IconPaintBrush");
export const IconPencil = makeIcon("IconPencil");
export const IconPlusMedium = makeIcon("IconPlusMedium");
export const IconPuzzle = makeIcon("IconPuzzle");
export const IconBubbleText = makeIcon("IconBubbleText");
export const IconBook = makeIcon("IconBook");
export const IconSettingsSliderHor = makeIcon("IconSettingsSliderHor");
export const IconCode = makeIcon("IconCode");
export const IconSushi = makeIcon("IconSushi");
export const IconSplit = makeIcon("IconSplit");
export const IconSidebar = makeIcon("IconSidebar");
export const IconCrossMedium = makeIcon("IconCrossMedium");
export const IconPlay = makeIcon("IconPlay");
export const IconPause = makeIcon("IconPause");
export const IconVolumeFull = makeIcon("IconVolumeFull");
export const IconVolumeHalf = makeIcon("IconVolumeHalf");
export const IconVolumeMinimum = makeIcon("IconVolumeMinimum");
export const IconVolumeOff = makeIcon("IconVolumeOff");
export const IconBack10s = makeIcon("IconBack10s");
export const IconForwards10s = makeIcon("IconForwards10s");
export const IconDownsize = makeIcon("IconDownsize");
