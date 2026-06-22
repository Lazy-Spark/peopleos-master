"use client";

import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * CopyButton — copies the given text to the clipboard and shows a brief
 * "Copied" confirmation. Used by the JD Writer ("copy / use as JD text") and
 * the Outreach panel (each variant / subject line is copyable).
 *
 * Falls back gracefully where the async Clipboard API is unavailable (e.g.
 * non-secure contexts): it selects nothing and simply does not confirm, rather
 * than throwing.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  size = "sm",
  variant = "outline",
  className,
}: {
  /** The text placed on the clipboard. */
  value: string;
  label?: string;
  copiedLabel?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = React.useCallback(async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard denied/unavailable — leave the label unchanged.
    }
  }, [value]);

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={onCopy}
      aria-label={label}
      className={cn(className)}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}
