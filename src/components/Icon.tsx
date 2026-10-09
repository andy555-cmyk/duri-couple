const PATHS: Record<string, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M19 11a7 7 0 0 1-14 0 M12 18v3',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  send: 'M5 12h14 M13 6l6 6-6 6',
  play: 'M8 5.5v13l10-6.5-10-6.5Z',
  slow: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 2',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  close: 'M6 6l12 12 M18 6L6 18',
  speaker: 'M4 9v6h4l5 4V5L8 9H4Z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  speakerOff: 'M4 9v6h4l5 4V5L8 9H4Z M17 9l4 6 M21 9l-4 6',
  face: 'M4 4h16v7H4z M4 13h16v7H4z M9 7.5h6 M9 16.5h6',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  share: 'M12 3v12 M7 8l5-5 5 5 M5 13v7h14v-7',
  paste: 'M9 4h6v3H9z M7 5H5v16h14V5h-2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14 M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M20 20l-4-4',
  trash: 'M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Z',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  message: 'M4 6h16v12H4z M4 7l8 6 8-6',
  book: 'M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Z M5 16a4 4 0 0 1 4-4h10',
  people: 'M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M2 20c.8-3.5 3.4-5.5 6.5-5.5S14.2 16.5 15 20 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14.8c2 .8 3.4 2.6 4 5.2',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4.5h-4.5',
  key: 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 11h9 M18 11v3 M15 11v2',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  upload: 'M12 16V5 M7 10l5-5 5 5 M5 20h14',
  wave: 'M3 12h2 M7 8v8 M11 5v14 M15 9v6 M19 11v2',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
};

export function Icon({ name, size = 20, fill = false, className }: { name: keyof typeof PATHS | string; size?: number; fill?: boolean; className?: string }) {
  const d = PATHS[name] || PATHS.more;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
