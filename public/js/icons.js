/**
 * icons.js — hand-drawn line icons (1.6 px stroke, round caps), in the spirit of SF Symbols.
 * No emoji anywhere in the UI (project rule). Usage: icon("radar") → SVG string.
 */
const P = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18.4 5.6"/><circle cx="16" cy="9" r="1.2" fill="currentColor" stroke="none"/>',
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  timeline: '<path d="M4 7h9M4 12h14M4 17h6"/><path d="M16 5v4M20 10v4M13 15v4"/>',
  value: '<path d="M12 3v18"/><path d="M16.5 7.5c-.6-1.4-2.3-2.3-4.5-2.3-2.6 0-4.3 1.2-4.3 3.1 0 4.4 9 2.4 9 6.9 0 2-1.9 3.3-4.7 3.3-2.4 0-4.2-1-4.8-2.7"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6l-7-3Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z"/><path d="M8 12h2l1.2-2 1.8 4 1.2-2H16"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5Z"/><circle cx="12" cy="12.5" r="3.5"/>',
  doc: '<path d="M7 3h7l4 4v14H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  play: '<path d="M8 5.5v13l10-6.5Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  ear: '<path d="M7 10a5 5 0 0 1 10 0c0 3-3 4-3 6.5a2.5 2.5 0 0 1-4.5 1.5"/><path d="M10 10a2 2 0 0 1 4 0"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  minus: '<path d="M6 12h12"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bag: '<path d="M5 8h14l-1 12H6Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  flag: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cloud: '<path d="M7 18h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.3 11 3.5 3.5 0 0 0 7 18Z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  chat: '<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6l-4.5 4v-4H7a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8.5 9h7M8.5 12h4.5"/>',
  sparkle: '<path d="M12 3.5 13.8 10 20.5 12l-6.7 2-1.8 6.5-1.8-6.5L3.5 12l6.7-2Z"/>',
};

export const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ""}</svg>`;

/** App mark: radar sweep in a rounded square (own design). */
export const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#5e5ce6"/></linearGradient></defs>
<rect width="32" height="32" rx="8" fill="url(#lg)"/><circle cx="16" cy="16" r="9" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.5"/>
<circle cx="16" cy="16" r="4.5" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.5"/><path d="M16 16 22.4 9.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
<circle cx="20.5" cy="12.8" r="1.8" fill="#fff"/></svg>`;
