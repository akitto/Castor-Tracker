const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Logo = () => (
  <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
    <rect width="30" height="30" rx="8" fill="#0B5E7E" />
    <path d="M7 21H12V16H17V12H23" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const IconHome = () => (<svg {...common}><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /></svg>);
export const IconChart = () => (<svg {...common}><path d="M4 19h16" /><path d="M5 15l4-5 4 3 6-7" /></svg>);
export const IconHistory = () => (<svg {...common}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></svg>);
export const IconMethod = () => (<svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 11v5M12 8h.01" /></svg>);
export const IconUpload = () => (<svg {...common} width={18} height={18}><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>);
export const IconDownload = () => (<svg {...common} width={18} height={18}><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>);
