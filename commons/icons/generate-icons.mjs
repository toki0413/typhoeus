// Generate PWA icons with a simple Reaction-Diffusion spot + Commons text
// Uses Canvas in Node via canvas package if available, otherwise writes SVG
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

mkdirSync(dirname(new URL('./dummy', import.meta.url).pathname), { recursive: true });

// ============ Generate SVG icons (always works) ============
const sizes = [192, 512];
for (const size of sizes) {
  // Background: deep indigo-lavender gradient matching Commons theme
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a0f2e"/>
      <stop offset="100%" stop-color="#2d1b4e"/>
    </linearGradient>
    <radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#8ef5d4"/>
      <stop offset="40%" stop-color="#5ce6b8"/>
      <stop offset="75%" stop-color="#7c5ce0" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#2d1b4e" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size*0.18}" ry="${size*0.18}" fill="url(#bg)"/>
  <!-- Reaction-Diffusion spots cluster -->
  <g fill="url(#spot)" opacity="0.95">
    <circle cx="${size*0.5}" cy="${size*0.45}" r="${size*0.28}"/>
    <circle cx="${size*0.72}" cy="${size*0.35}" r="${size*0.12}"/>
    <circle cx="${size*0.32}" cy="${size*0.62}" r="${size*0.1}"/>
    <circle cx="${size*0.65}" cy="${size*0.68}" r="${size*0.09}"/>
    <circle cx="${size*0.28}" cy="${size*0.28}" r="${size*0.07}"/>
  </g>
  <!-- Commons text -->
  <text x="${size/2}" y="${size*0.85}" text-anchor="middle" 
        font-family="-apple-system, 'SF Pro Display', system-ui, sans-serif" 
        font-weight="300" font-size="${size*0.16}" letter-spacing="${size*0.02}"
        fill="#c5b6e8">commons</text>
</svg>`;
  writeFileSync(`/workspace/commons/icons/icon-${size}.svg`, svg);
  console.log(`✅ icon-${size}.svg`);
}
writeFileSync('/workspace/commons/icons/icon-maskable.svg', 
  svg.replace(`rx="${size*0.18}" ry="${size*0.18}"`, '').replace('rect width', 'rect width').replace('rx','').replace('ry','').replace('${size*0.18}','0').replace('${size*0.18}','0'));
console.log(`✅ icon-maskable.svg`);
