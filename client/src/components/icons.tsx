interface IconProps {
  className?: string;
}

const common = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function MicIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" />
    </svg>
  );
}

export function MicOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <path d="M3 3l18 18M9 9v3a3 3 0 0 0 4.24 2.73M15 9V6a3 3 0 0 0-5.91-.74M12 18v3m-4 0h8M5 11a7 7 0 0 0 9.9 6.36" />
    </svg>
  );
}

export function CameraIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <rect x="3" y="6" width="12" height="12" rx="3" />
      <path d="M21 8l-6 4 6 4V8Z" />
    </svg>
  );
}

export function CameraOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <path d="M3 3l18 18M15 6H6a3 3 0 0 0-3 3v6c0 .68.22 1.31.6 1.82M9 18h3a3 3 0 0 0 3-3v-1M21 8l-4.5 3" />
    </svg>
  );
}

export function CaptionsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M7 13h2m0 0v.01M7 13a1 1 0 1 0 2 1M13 13h2m0 0v.01M13 13a1 1 0 1 0 2 1" />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <path d="M4 5h16v11H8l-4 4V5Z" />
    </svg>
  );
}

export function PeopleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 8a3 3 0 1 1 0-.001M15 14.5c2.5.4 4.5 2.6 4.5 5.5" />
    </svg>
  );
}

export function PhoneOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M6.6 10.8c1.4 2.7 3.9 5.2 6.6 6.6l2.2-2.2a1 1 0 0 1 1.1-.23c1.2.42 2.5.65 3.8.65a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1C10.4 21.15 2.85 13.6 2.85 4.5a1 1 0 0 1 1-1H7.3a1 1 0 0 1 1 1c0 1.32.23 2.6.65 3.8a1 1 0 0 1-.24 1.1L6.6 10.8Z" />
    </svg>
  );
}

export function TranscriptIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <path d="M7 3h7l5 5v13H7V3Z" />
      <path d="M14 3v5h5M9 12h6M9 15.5h6M9 8.5h2" />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M3.4 20.6 21 12 3.4 3.4 3 10l12 2-12 2 .4 6.6Z" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function GlobeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 4 6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-6-4-9s1.5-6.4 4-9Z" />
    </svg>
  );
}
