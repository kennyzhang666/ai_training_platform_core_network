import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'grid'
  | 'users'
  | 'clock'
  | 'challenge'
  | 'participants'
  | 'capabilities'
  | 'grading'
  | 'runtime'
  | 'announcement'
  | 'audit'
  | 'upload'
  | 'git'
  | 'check'
  | 'warning'
  | 'arrow-right'
  | 'plus'
  | 'dot';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  name: IconName;
  size?: number;
  strokeWidth?: number;
};

/**
 * Small, dependency-free line icons used by both employee and administrator
 * views. Text glyphs are deliberately avoided because their shape changes
 * between operating-system fonts and made the previous UI look inconsistent.
 */
export function Icon({ name, size = 18, strokeWidth = 1.8, ...props }: IconProps) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  let content: ReactNode;
  switch (name) {
    case 'grid':
      content = <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>;
      break;
    case 'users':
      content = <><path d="M16 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 19.5V21" /><circle cx="10" cy="7.5" r="3.5" /><path d="M16.5 4.5a3.5 3.5 0 0 1 0 6.8M18 15.2a4.5 4.5 0 0 1 3 4.3V21" /></>;
      break;
    case 'clock':
      content = <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>;
      break;
    case 'challenge':
      content = <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.4 7.7 7.6 4.4 7.6-4.4M12 12.1V21" /></>;
      break;
    case 'participants':
      content = <><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M17 8v6M14 11h6" /></>;
      break;
    case 'capabilities':
      content = <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><path d="M12 3.5V1.8M20.5 12h1.7M12 20.5v1.7M3.5 12H1.8" /></>;
      break;
    case 'grading':
      content = <><circle cx="12" cy="12" r="8.5" /><path d="m8 12 2.6 2.7L16.5 9" /></>;
      break;
    case 'runtime':
      content = <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 16h4" /></>;
      break;
    case 'announcement':
      content = <><path d="M4 14V10l12-4v12L4 14Z" /><path d="M16 9.5h2.2A2.8 2.8 0 0 1 21 12.3v.4a2.8 2.8 0 0 1-2.8 2.8H16M7 14l1.2 5H11l-1.1-4.3" /></>;
      break;
    case 'audit':
      content = <><path d="M5 5h14M5 12h14M5 19h14" /><circle cx="3" cy="5" r=".8" fill="currentColor" stroke="none" /><circle cx="3" cy="12" r=".8" fill="currentColor" stroke="none" /><circle cx="3" cy="19" r=".8" fill="currentColor" stroke="none" /></>;
      break;
    case 'upload':
      content = <><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M5 19.5h14" /></>;
      break;
    case 'git':
      content = <><circle cx="7" cy="5" r="2" /><circle cx="17" cy="19" r="2" /><circle cx="17" cy="7" r="2" /><path d="M7 7v5a4 4 0 0 0 4 4h4M15 7h-2" /></>;
      break;
    case 'check':
      content = <><path d="m5 12 4.2 4.2L19 6.5" /></>;
      break;
    case 'warning':
      content = <><path d="m12 3 9 16H3L12 3Z" /><path d="M12 9v4M12 16.5v.1" /></>;
      break;
    case 'arrow-right':
      content = <><path d="M4 12h15M13 6l6 6-6 6" /></>;
      break;
    case 'plus':
      content = <><path d="M12 5v14M5 12h14" /></>;
      break;
    case 'dot':
      content = <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />;
      break;
  }

  return <svg aria-hidden="true" focusable="false" data-icon={name} viewBox="0 0 24 24" width={size} height={size} {...common} {...props}>{content}</svg>;
}
