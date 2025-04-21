import { languageColorCache, getAndIncrementColorIndex } from '../state.ts';
import { baseColors } from '../config.ts';

/**
 * Gets a consistent color for a given language code or potentially another key.
 * Uses a cache and a rotating palette (baseColors).
 * @param key The key to associate with the color (e.g., langCode).
 * @returns A color string (e.g., 'rgba(54, 162, 235, 1)').
 */
export function getLanguageColor(key: string): string { // Renamed param for clarity
    if (!languageColorCache[key]) {
        const currentIndex = getAndIncrementColorIndex(); // Get index and increment state via function
        languageColorCache[key] = baseColors[currentIndex % baseColors.length];
        // colorIndex++; // Removed direct modification
    }
    return languageColorCache[key];
}

/**
 * Modifies a base color string (intended for MA lines).
 * Currently makes the 'short' MA line fainter.
 * @param color The base RGBA color string.
 * @param type Whether it's for the 'short' or 'long' moving average.
 * @returns A modified RGBA color string.
 * @deprecated This approach might be less flexible than direct styling in dataset creation.
 */
export function modifyColor(color: string, type: 'short' | 'long'): string {
    if (type === 'short') {
        return color.replace(', 1)', ', 0.4)'); // Fainter for short MA
    }
    return color; // Solid for long MA
} 