// Иконки 24×24 (штрих) из mockup/redesign/icons.js
const ICONS = {
  "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75\"/>",
  "layers": "<path d=\"m12 2 10 5-10 5L2 7l10-5z\"/><path d=\"m2 17 10 5 10-5M2 12l10 5 10-5\"/>",
  "calendar": "<rect x=\"3\" y=\"4.5\" width=\"18\" height=\"17\" rx=\"3\"/><path d=\"M16 2.5v4M8 2.5v4M3 10h18\"/>",
  "alert": "<path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\"/><path d=\"M12 9v4M12 17h.01\"/>",
  "file": "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><path d=\"M14 2v6h6M16 13H8M16 17H8M10 9H8\"/>",
  "briefcase": "<rect x=\"2\" y=\"7\" width=\"20\" height=\"14\" rx=\"2.5\"/><path d=\"M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\"/>",
  "badge": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"3\"/><circle cx=\"9\" cy=\"10.5\" r=\"2.2\"/><path d=\"M5.8 16.5a3.6 3.6 0 0 1 6.4 0M15 9h3M15 13h3\"/>",
  "chart": "<path d=\"M3 3v18h18\"/><path d=\"M7.5 16v-4M12 16V8M16.5 16v-6\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>",
  "clip": "<path d=\"M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.4 3.4 0 014.8 4.8l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9\"/>",
  "up": "<path d=\"M12 19V5M5.5 11.5 12 5l6.5 6.5\"/>",
  "down": "<path d=\"m6 9 6 6 6-6\"/>",
  "left": "<path d=\"m15 18-6-6 6-6\"/>",
  "right": "<path d=\"m9 18 6-6-6-6\"/>",
  "arrow": "<path d=\"M5 12h14M13 6l6 6-6 6\"/>",
  "x": "<path d=\"M18 6 6 18M6 6l12 12\"/>",
  "plus": "<path d=\"M12 5v14M5 12h14\"/>",
  "check": "<path d=\"M20 6 9 17l-5-5\"/>",
  "sparkle": "<path d=\"M12 3.5 13.9 9a2 2 0 0 0 1.2 1.2l5.4 1.8-5.4 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.1 15a2 2 0 0 0-1.2-1.2L3.5 12l5.4-1.8A2 2 0 0 0 10.1 9z\"/>",
  "cap": "<path d=\"M22 10 12 5 2 10l10 5 10-5z\"/><path d=\"M6 12v5c3 3 9 3 12 0v-5M22 10v6\"/>",
  "wallet": "<path d=\"M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3\"/><path d=\"M21 9h-5a3 3 0 0 0 0 6h5z\"/>",
  "award": "<circle cx=\"12\" cy=\"8.5\" r=\"5.5\"/><path d=\"M8.5 13 7 22l5-3 5 3-1.5-9\"/>",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>",
  "pin": "<path d=\"M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z\"/><circle cx=\"12\" cy=\"9.5\" r=\"2.5\"/>",
  "building": "<rect x=\"4\" y=\"2.5\" width=\"16\" height=\"19\" rx=\"2\"/><path d=\"M9 21.5v-4h6v4M8.5 7h.01M12 7h.01M15.5 7h.01M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 15h.01M15.5 15h.01\"/>",
  "grid": "<rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"2\"/>",
  "list": "<path d=\"M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01\"/>",
  "phone": "<path d=\"M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z\"/>",
  "mail": "<rect x=\"2.5\" y=\"4.5\" width=\"19\" height=\"15\" rx=\"3\"/><path d=\"m3 7 9 6 9-6\"/>",
  "trend": "<path d=\"m3 17 6-6 4 4 8-8\"/><path d=\"M15 7h6v6\"/>",
  "edit": "<path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z\"/>",
  "hourglass": "<path d=\"M6 2h12M6 22h12M7 2v4.2a4 4 0 0 0 1.4 3L12 12l3.6-2.8a4 4 0 0 0 1.4-3V2M7 22v-4.2a4 4 0 0 1 1.4-3L12 12l3.6 2.8a4 4 0 0 1 1.4 3V22\"/>",
  "done": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m8 12.5 2.8 2.8L16.5 9.5\"/>",
  "inbox": "<path d=\"M22 12h-6l-2 3h-4l-2-3H2\"/><path d=\"M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z\"/>",
  "flag": "<path d=\"M4 22V4a1 1 0 0 1 .4-.8C5.3 2.5 6.7 2 8.5 2c3 0 4.5 2 7.5 2 1.4 0 2.6-.3 3.6-.8.4-.2.9.1.9.6v10.4a1 1 0 0 1-.5.9c-1.1.6-2.4.9-4 .9-3 0-4.5-2-7.5-2-1.8 0-3.2.5-4.4 1.2\"/>",
  "trash": "<path d=\"M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\"/>",
  "logout": "<path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9\"/>",
  "stop": "<rect x=\"6.5\" y=\"6.5\" width=\"11\" height=\"11\" rx=\"2\"/>",
  "more": "<circle cx=\"5\" cy=\"12\" r=\"1.2\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\"/><circle cx=\"19\" cy=\"12\" r=\"1.2\"/>",
  "message": "<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>",
  "refresh": "<path d=\"M21 12a9 9 0 1 1-2.6-6.4L21 8\"/><path d=\"M21 3v5h-5\"/>",
  "sidebar": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M9 4v16\"/>",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "ic" }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
  );
}
