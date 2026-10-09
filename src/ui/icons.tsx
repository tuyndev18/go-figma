// 16px line icons drawn with currentColor, so they follow the text color.
import type { ReactNode } from "react";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5h-5.5A1.25 1.25 0 0 0 2.5 3.75v5.5a1.25 1.25 0 0 0 1.25 1.25H5.5" />
  </Icon>
);

export const ImageIcon = () => (
  <Icon>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <circle cx="6" cy="6.5" r="1" />
    <path d="m13.5 10.5-3-3-6 5.5" />
  </Icon>
);

export const ExportIcon = () => (
  <Icon>
    <path d="M8 2.5v7.5M5 7l3 3 3-3" />
    <path d="M2.5 10.5v1.75c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V10.5" />
  </Icon>
);

export const SlidersIcon = () => (
  <Icon>
    <path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6" />
    <circle cx="10" cy="5" r="1.5" />
    <circle cx="6" cy="11" r="1.5" />
  </Icon>
);

export const SparkleIcon = () => (
  <Icon>
    <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3z" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon size={12}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);

export const WarningIcon = () => (
  <Icon>
    <path d="M7.13 2.98a1 1 0 0 1 1.74 0l5.13 9a1 1 0 0 1-.87 1.5H2.87a1 1 0 0 1-.87-1.5z" />
    <path d="M8 6.5v2.75M8 11.25v.01" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 2.5v2.5h-2.5" />
  </Icon>
);

export const PlugIcon = () => (
  <Icon>
    <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0zM8 11v2.5" />
  </Icon>
);

export const FrameIcon = () => (
  <Icon size={20}>
    <path d="M5 2.5v11M11 2.5v11M2.5 5h11M2.5 11h11" />
  </Icon>
);
