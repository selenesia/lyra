import { useEffect, useState } from "preact/hooks";

type ChatDialogNotice = { text: string; tone: "error" | "success" };

const NOTICE_DURATION_MS = 5_000;

export function useChatDialogNotice() {
  const [notice, setNotice] = useState<ChatDialogNotice | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return [notice, setNotice] as const;
}
