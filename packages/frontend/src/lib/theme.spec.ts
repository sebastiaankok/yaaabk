import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const css = read('../routes/layout.css');
const favicon = read('../lib/assets/favicon.svg');

/** Every custom property in the light `:root` block. */
function lightTokens(source: string): Record<string, string> {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? '';
  const tokens: Record<string, string> = {};
  for (const match of root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

const tokens = lightTokens(css);

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const textPairs: Array<[string, string]> = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'surface-tint'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['link', 'background'],
  ['link', 'secondary'],
  ['destructive', 'background'],
  ['success', 'background'],
  ['warning', 'background'],
  ['foreground', 'surface-tint'],
];

const boundaryPairs: Array<[string, string]> = [
  ['input', 'background'],
  ['border', 'background'],
  ['ring', 'background'],
  ['primary', 'background'],
];

describe('design tokens', () => {
  it('uses Google Blue for primary fills and an AA-safe blue for text and links', () => {
    expect(tokens.primary?.toUpperCase()).toBe('#1A73E8');
    expect(tokens.link?.toUpperCase()).toBe('#1557B0');
    expect(tokens['primary-foreground']?.toUpperCase()).toBe('#FFFFFF');
  });

  it.each(textPairs)('%s on %s meets 4.5:1 body-text contrast', (foreground, background) => {
    const ratio = contrastRatio(tokens[foreground], tokens[background]);
    expect(
      ratio,
      `${foreground} (${tokens[foreground]}) on ${background} (${tokens[background]}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(boundaryPairs)('%s on %s meets 3:1 UI-boundary contrast', (foreground, background) => {
    const ratio = contrastRatio(tokens[foreground], tokens[background]);
    expect(
      ratio,
      `${foreground} (${tokens[foreground]}) on ${background} (${tokens[background]}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('defines the 8dp spacing rhythm, radius and elevation scale once in the theme layer', () => {
    expect(tokens['space-1']).toBe('8px');
    expect(tokens['space-2']).toBe('16px');
    expect(tokens['space-4']).toBe('32px');
    expect(tokens.radius).toBe('0.5rem');
    expect(tokens['elevation-1']).toContain('rgb');
    expect(tokens['elevation-overlay']).toContain('rgb');
  });

  it('uses Roboto for UI text and Roboto Mono for technical values instead of Geist', () => {
    expect(css).toContain("@import '@fontsource-variable/roboto';");
    expect(css).toContain("@import '@fontsource-variable/roboto-mono';");
    expect(css).not.toMatch(/geist/i);
    expect(tokens['font-sans']).toContain('Roboto');
    expect(tokens['font-mono']).toContain('Roboto Mono');
  });

  it('ships a brand favicon instead of the stock Svelte logo', () => {
    expect(favicon).not.toMatch(/svelte/i);
    expect(favicon).toContain('#1A73E8');
  });
});
