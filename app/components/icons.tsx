// Magic icon set — inline SVG, no emoji. Stroke style, 24 viewBox.

type P = { className?: string };

const base = (className?: string) =>
  className ?? "h-5 w-5 shrink-0";

function I({ className, children, filled }: P & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={base(className)}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: P) => (
  <I {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </I>
);

export const IconCampaign = (p: P) => (
  <I {...p}>
    <path d="M3 11v3l4 .5V10.5L3 11z" />
    <path d="M7 10.5 18 5v13l-11-3.5" />
    <path d="M18 8.5a3 3 0 0 1 0 6" />
    <path d="M9 15.5V19a1.5 1.5 0 0 0 3 0v-2.7" />
  </I>
);

export const IconClips = (p: P) => (
  <I {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4" />
  </I>
);

export const IconPost = (p: P) => (
  <I {...p}>
    <path d="M12 16V4m0 0 4 4m-4-4L8 8" />
    <path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4" />
  </I>
);

export const IconConnections = (p: P) => (
  <I {...p}>
    <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
    <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
  </I>
);

export const IconBell = (p: P) => (
  <I {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
    <path d="M10 20a2.2 2.2 0 0 0 4 0" />
  </I>
);

export const IconActivity = (p: P) => (
  <I {...p}>
    <path d="M3 12h4l2.5-6 4 12L16 12h5" />
  </I>
);

export const IconSettings = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.35.94A7 7 0 0 0 14 5.1L13.7 2.6h-3.4L10 5.1a7 7 0 0 0-2.5 1.44l-2.36-.94-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.35-.94a7 7 0 0 0 2.5 1.44l.3 2.5h3.4l.3-2.5a7 7 0 0 0 2.5-1.44l2.36.94 2-3.46-2-1.55c.1-.45.14-.92.14-1.4z" />
  </I>
);

export const IconPhone = (p: P) => (
  <I {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M10.5 5h3" />
    <circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none" />
  </I>
);

export const IconUser = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </I>
);

export const IconShield = (p: P) => (
  <I {...p}>
    <path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6l-7-3z" />
    <path d="m9.5 12 2 2 3.5-4" />
  </I>
);

export const IconMore = (p: P) => (
  <I {...p} filled>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </I>
);

export const IconX = (p: P) => (
  <I {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </I>
);

export const IconLogout = (p: P) => (
  <I {...p}>
    <path d="M14 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h8" />
    <path d="M10 12h11m0 0-3.5-3.5M21 12l-3.5 3.5" />
  </I>
);

export const IconSparkles = (p: P) => (
  <I {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z" />
  </I>
);

export const IconCheck = (p: P) => (
  <I {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </I>
);

export const IconClock = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </I>
);
