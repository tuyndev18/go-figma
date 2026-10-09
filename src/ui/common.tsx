import type { ReactNode } from "react";
import type { ToPluginMessage } from "../shared/messages";

export const send = (message: ToPluginMessage) => parent.postMessage({ pluginMessage: message }, "*");

export function copyText(text: string): void {
  // The Clipboard API is blocked inside the plugin iframe; execCommand still works.
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  send({ type: "notify", message: ok ? "Copied to clipboard" : "Copy failed" });
}

/** A button that copies `text`; its look comes from `className` (btn-primary, btn-utility, btn-icon). */
export function CopyButton({
  text,
  title,
  className = "btn-utility",
  children,
}: {
  text: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button className={className} title={title} aria-label={title} onClick={() => copyText(text)}>
      {children}
    </button>
  );
}
