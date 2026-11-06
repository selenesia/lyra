import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

interface EditableFieldProps {
  id: string;
  label: string;
  placeholder: string;
  value?: string;
  disabled?: boolean;
  fieldRef?: RefObject<HTMLDivElement>;
  onChange?: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export default function EditableField({
  id,
  label,
  placeholder,
  value,
  disabled = false,
  fieldRef,
  onChange,
  onKeyDown,
}: EditableFieldProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = fieldRef ?? localRef;

  useLayoutEffect(() => {
    const field = ref.current;
    if (field && value !== undefined && field.textContent !== value) {
      field.textContent = value;
    }
  }, [ref, value]);

  useLayoutEffect(() => {
    if (disabled && document.activeElement === ref.current) ref.current?.blur();
  }, [disabled, ref]);

  return (
    <div
      ref={ref}
      id={id}
      class="editable-field"
      contentEditable={disabled ? false : "plaintext-only"}
      role="textbox"
      aria-label={label}
      aria-multiline="false"
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      tabIndex={disabled ? -1 : 0}
      spellcheck={false}
      onInput={(event) => {
        if (disabled) return;
        const field = event.currentTarget;
        if (!field.textContent) field.textContent = "";
        onChange?.(field.textContent ?? "");
      }}
      onKeyDown={(event) => {
        if (disabled || event.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.repeat) return;
        }
        onKeyDown?.(event);
      }}
      onBeforeInput={(event) => {
        const { inputType } = event as InputEvent;
        if (disabled || inputType === "insertParagraph" || inputType === "insertLineBreak") {
          event.preventDefault();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        if (disabled) return;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, text.replace(/[\r\n]/g, ""));
      }}
    />
  );
}
