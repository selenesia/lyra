export const navigationVersions = new WeakMap<HTMLIFrameElement, number>();

export function beginNavigation(iframe: HTMLIFrameElement): number {
  const version = (navigationVersions.get(iframe) ?? 0) + 1;
  navigationVersions.set(iframe, version);
  return version;
}

export function isCurrentNavigation(
  iframe: HTMLIFrameElement,
  version: number,
): boolean {
  return navigationVersions.get(iframe) === version;
}
