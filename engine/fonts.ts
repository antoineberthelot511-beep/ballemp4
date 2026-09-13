/**
 * Les familles de polices diffèrent entre le navigateur et napi-rs. L'hôte
 * enregistre ici les noms réellement disponibles, et le HUD ne référence que
 * ces alias — ce qui garde un rendu de texte identique dans les deux modes.
 */
export const fonts = {
  display: 'sans-serif',
  mono: 'monospace',
};

export function setFonts(next: Partial<typeof fonts>): void {
  if (next.display) fonts.display = next.display;
  if (next.mono) fonts.mono = next.mono;
}
