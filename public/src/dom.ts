// --- DOM Element References ---
export let loadingIndicator: HTMLElement | null = null;
export let timeWindowSelector: HTMLSelectElement | null = null;
export let languageCheckboxesContainer: HTMLElement | null = null; // Keep if language checkboxes come back
export let plottedSignalsListElement: HTMLElement | null = null;
export let addSignalBtn: HTMLButtonElement | null = null;
export let signalSelectorDiv: HTMLElement | null = null;
export let availableSignalsList: HTMLElement | null = null;
export let signalColorInput: HTMLInputElement | null = null;
export let confirmSignalBtn: HTMLButtonElement | null = null;
export let cancelSignalBtn: HTMLButtonElement | null = null;
export let langSelect: HTMLSelectElement | null = null;
export let showRawCheckbox: HTMLInputElement | null = null;
export let showShortMACheckbox: HTMLInputElement | null = null;
export let showLongMACheckbox: HTMLInputElement | null = null;

/**
 * Assigns DOM elements to the exported variables after the DOM is loaded.
 * Should be called within the DOMContentLoaded event listener.
 */
export function assignDOMElements(): void {
    loadingIndicator = document.getElementById('loadingIndicator');
    timeWindowSelector = document.getElementById('timeWindowSelector') as HTMLSelectElement;
    plottedSignalsListElement = document.getElementById('plottedSignalsList');
    addSignalBtn = document.getElementById('addSignalBtn') as HTMLButtonElement;
    signalSelectorDiv = document.getElementById('signalSelector');
    availableSignalsList = document.getElementById('availableSignalsList');
    signalColorInput = document.getElementById('signalColor') as HTMLInputElement;
    confirmSignalBtn = document.getElementById('confirmSignalBtn') as HTMLButtonElement;
    cancelSignalBtn = document.getElementById('cancelSignalBtn') as HTMLButtonElement;
    langSelect = document.getElementById('langSelect') as HTMLSelectElement;
    showRawCheckbox = document.getElementById('showRaw') as HTMLInputElement;
    showShortMACheckbox = document.getElementById('showShortMA') as HTMLInputElement;
    showLongMACheckbox = document.getElementById('showLongMA') as HTMLInputElement;
    languageCheckboxesContainer = document.getElementById('languageCheckboxesContainer');
} 