import { useImageLoad } from "../../hooks/useImageLoad.ts";
import { IconPlay } from "../icons";
import IconBase from "../icons/IconBase.tsx";
import { ICON_PATHS } from "../icons/paths.ts";

export default function WatchResumeCard({
  title,
  posterUrl,
  caption,
  onResume,
}: {
  title: string;
  posterUrl: string;
  caption: string;
  onResume: () => void;
}) {
  const image = useImageLoad(posterUrl);
  return (
    <button type="button" class="watch-resume-card" onClick={onResume}>
      <span
        class={`poster-cover${image.loaded ? " loaded" : ""}${image.errored ? " no-cover" : ""}`}
      >
        {image.errored ? (
          <span class="no-cover-icon">
            <IconBase icon={ICON_PATHS.IconImageAltText} />
          </span>
        ) : (
          <img
            ref={image.imgRef}
            src={image.src}
            alt=""
            onLoad={image.onLoad}
            onError={image.onError}
          />
        )}
      </span>
      <span class="watch-info">
        <span class="watch-resume-caption">continue watching...</span>
        <span class="watch-resume-title">{title}</span>
        <span class="watch-resume-caption">{caption}</span>
      </span>
      <IconPlay class="watch-resume-play" />
    </button>
  );
}
