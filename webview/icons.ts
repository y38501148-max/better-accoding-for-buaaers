const paths = {
  code: '<path d="m6 5-4 5 4 5m8-10 4 5-4 5m-3-12-2 14"/>',
  play: '<path d="m7 4 9 6-9 6V4Z"/>',
  send: '<path d="m3 9 14-6-6 14-2-6-6-2Zm6 2 8-8"/>',
  debug:
    '<rect x="6" y="6" width="8" height="10" rx="4"/><path d="m7 3 2 3m4-3-2 3M3 8h3m8 0h3M2 12h4m8 0h4M4 17l3-3m6 0 3 3M10 7v8"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  list: '<path d="M8 5h9M8 10h9M8 15h9M3 5h.01M3 10h.01M3 15h.01"/>',
  refresh:
    '<path d="M16 7a6.5 6.5 0 0 0-11-2L3 7m0-4v4h4m-3 6a6.5 6.5 0 0 0 11 2l2-2m-4 0h4v4"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="2"/>',
  settings:
    '<path d="m8 2-1 3-3 1 1 3-2 2 2 2v3h3l2 2 2-2h3v-3l2-2-2-2 1-3-3-1-1-3H8Z"/><circle cx="10" cy="10" r="3"/>',
  book: '<path d="M10 5c-2-2-5-2-8-1v12c3-1 6-1 8 1 2-2 5-2 8-1V4c-3-1-6-1-8 1Zm0 0v12"/>',
  tests:
    '<path d="m3 5 1.5 1.5L7 3M10 5h7M3 11l1.5 1.5L7 9m3 2h7M3 17l1.5 1.5L7 15m3 2h7"/>',
  history: '<path d="M3 8a7 7 0 1 1 1 7M3 3v5h5m2-3v5l3 2"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
  memory:
    '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3M8 8h4v4H8z"/>',
  chevron: '<path d="m6 8 4 4 4-4"/>',
  file: '<path d="M11 2H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-5-5Zm0 0v5h5M7 11h6m-6 3h4"/>',
  check: '<path d="m4 10 4 4 8-8"/>',
  copy: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3"/>',
  trash: '<path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6"/>',
  up: '<path d="m5 11 5-5 5 5M10 6v10"/>',
  down: '<path d="m5 9 5 5 5-5m-5-6v10"/>',
  more: '<circle cx="4" cy="10" r=".75"/><circle cx="10" cy="10" r=".75"/><circle cx="16" cy="10" r=".75"/>',
  import: '<path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4"/>',
  undo: '<path d="M3 4v5h5M3 9l4-4a6 6 0 1 1 0 10"/>',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): string {
  return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
