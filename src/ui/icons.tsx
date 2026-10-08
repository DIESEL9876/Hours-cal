import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...p }: P, path: React.ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      {path}
    </svg>
  );
}

export const IconBuilding = (p: P) => base(p, <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3" /></>);
export const IconUsers = (p: P) => base(p, <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.6 3 5.2" /></>);
export const IconClock = (p: P) => base(p, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconPlus = (p: P) => base(p, <path d="M12 5v14M5 12h14" />);
export const IconEdit = (p: P) => base(p, <><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>);
export const IconChevronLeft = (p: P) => base(p, <path d="M15 6l-6 6 6 6" />);
export const IconChevronRight = (p: P) => base(p, <path d="M9 6l6 6-6 6" />);
export const IconArrowBack = (p: P) => base(p, <path d="M5 12h14M13 6l6 6-6 6" />);
export const IconSearch = (p: P) => base(p, <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>);
export const IconInfo = (p: P) => base(p, <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IconAlert = (p: P) => base(p, <><path d="M12 3l9.5 17h-19L12 3z" /><path d="M12 10v4M12 17h.01" /></>);
export const IconCheck = (p: P) => base(p, <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconX = (p: P) => base(p, <path d="M6 6l12 12M18 6L6 18" />);
export const IconTrash = (p: P) => base(p, <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const IconDownload = (p: P) => base(p, <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>);
export const IconPrinter = (p: P) => base(p, <><path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>);
export const IconUndo = (p: P) => base(p, <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>);
export const IconRedo = (p: P) => base(p, <><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></>);
export const IconDatabase = (p: P) => base(p, <><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" /><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" /></>);
export const IconChart = (p: P) => base(p, <><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>);
export const IconMore = (p: P) => base(p, <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>);
export const IconShield = (p: P) => base(p, <><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>);
export const IconHistory = (p: P) => base(p, <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>);
export const IconBook = (p: P) => base(p, <><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5z" /><path d="M4 19a2 2 0 0 1 2-2h14" /></>);
export const IconLock = (p: P) => base(p, <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const IconCalendar = (p: P) => base(p, <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>);
