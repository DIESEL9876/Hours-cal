import type { SVGProps } from 'react';
export * from '../../src/ui/icons';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...p }: P, path: React.ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      {path}
    </svg>
  );
}

export const IconKey = (p: P) => base(p, <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></>);
export const IconMonitor = (p: P) => base(p, <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>);
export const IconCopy = (p: P) => base(p, <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>);
export const IconFolder = (p: P) => base(p, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />);
export const IconUpload = (p: P) => base(p, <><path d="M12 16V5M7 10l5-5 5 5" /><path d="M5 20h14" /></>);
export const IconFile = (p: P) => base(p, <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /></>);
export const IconRefresh = (p: P) => base(p, <><path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3" /><path d="M5 3v5h5M19 21v-5h-5" /></>);
export const IconBan = (p: P) => base(p, <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>);
