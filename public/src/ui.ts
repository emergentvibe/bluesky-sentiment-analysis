import { AVAILABLE_LANGUAGES, HOUR_MS } from './config.ts';
import { availableSignals, plottedSignals, setCurrentTimeWindowMs } from './state.ts';
import {
    langSelect,
    availableSignalsList,
    signalColorInput,
    showRawCheckbox,
    showShortMACheckbox,
    showLongMACheckbox,
    addSignalBtn,
    signalSelectorDiv,
    cancelSignalBtn,
    confirmSignalBtn,
    timeWindowSelector,
    plottedSignalsListElement
} from './dom.ts';
import { requestHistoryData } from './websocket.ts';
import { PlottedSignalConfig } from './types.ts';
import { createKeywordFilterSignal } from './api.ts';


// --- UI Controls Setup ---

/**
 * Sets up event listeners and populates dropdowns/lists for the UI controls.
 */
export function setupControls() {
    console.log("Setting up controls...");

    // --- Populate Language Selector ---
    if (langSelect) {
        langSelect.innerHTML = '';
        AVAILABLE_LANGUAGES.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang.code;
            option.textContent = lang.name;
            if (lang.code === 'eng') option.selected = true;
            langSelect.appendChild(option);
        });
    } else {
        console.error("Language select element ('langSelect') not found!");
    }

    // --- Populate Available Signals List ---
    if (availableSignalsList) {
        availableSignalsList.innerHTML = '';
        if (availableSignals.length === 0) {
            availableSignalsList.innerHTML = '<p>No signals available from backend.</p>';
        } else {
            availableSignals.forEach((signal, index) => {
                const div = document.createElement('div');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.id = `signal-radio-${signal.id || signal.name}`;
                radio.name = 'availableSignal';
                radio.value = signal.name;
                if (index === 0) radio.checked = true;

                const label = document.createElement('label');
                label.htmlFor = radio.id;
                label.textContent = `${signal.name} (${signal.type})`;
                label.style.marginLeft = '5px';

                div.appendChild(radio);
                div.appendChild(label);
                availableSignalsList.appendChild(div);
            });
        }
    } else {
         console.error("Available signals list element ('availableSignalsList') not found!");
    }

    // --- Event Listeners ---
    addSignalBtn?.addEventListener('click', () => {
        const keywordInputElement = document.getElementById('keywordInput') as HTMLInputElement | null;
        if (keywordInputElement) keywordInputElement.value = ''; 
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'block';
    });

    cancelSignalBtn?.addEventListener('click', () => {
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'none';
    });

    confirmSignalBtn?.addEventListener('click', async () => {
        console.log("Confirm Signal Button clicked!");

        // Get all required DOM elements
        const langElement = langSelect;
        const signalsListElement = availableSignalsList;
        const colorElement = signalColorInput;
        const showRawElement = showRawCheckbox;
        const showShortMAElement = showShortMACheckbox;
        const showLongMAElement = showLongMACheckbox;
        const keywordInputElement = document.getElementById('keywordInput') as HTMLInputElement | null;

        // Validate elements exist
        if (!langElement || !signalsListElement || !colorElement || !showRawElement || !showShortMAElement || !showLongMAElement || !keywordInputElement) {
             console.error("Cannot confirm signal: One or more required configuration elements are missing.");
             return;
        }

        // Add checks before accessing properties
        const selectedLang = langElement.value; 
        const selectedSignalRadio = signalsListElement.querySelector('input[name="availableSignal"]:checked') as HTMLInputElement | null;
        const selectedColor = colorElement.value; 
        const showRaw = showRawElement.checked; 
        const showShortMA = showShortMAElement.checked;
        const showLongMA = showLongMAElement.checked;
        const keywords = keywordInputElement.value.trim();

        if (!selectedSignalRadio) {
            console.warn("Could not add signal - No metric/signal selected.");
            alert("Please select a base signal/metric.");
            return;
        }
        const selectedBaseSignalName = selectedSignalRadio.value;

        let signalToAddName = selectedBaseSignalName;
        let signalToAddType: 'metric' | 'filter' = 'metric';

        const selectedBaseSignal = availableSignals.find(s => s.name === selectedBaseSignalName);
        if (selectedBaseSignal) {
            signalToAddType = selectedBaseSignal.type;
        }

        // If keywords are provided, create a new filter signal via API
        if (keywords.length > 0) {
             console.log("Keywords provided, attempting to create filter signal...");
             // Ensure selectedBaseSignalName is valid before calling API
             if (!selectedBaseSignalName) {
                 console.error("Cannot create filter: Base signal name is missing.");
                 alert("Cannot create filter without a selected base signal.");
                 return;
             }
             const createdFilter = await createKeywordFilterSignal(selectedBaseSignalName, selectedLang, keywords);
             if (createdFilter) {
                 signalToAddName = createdFilter.name; 
                 signalToAddType = 'filter';
                 console.log(`Using created filter signal name: ${signalToAddName}`);
             } else {
                 console.error("Failed to create keyword filter signal. Aborting add.");
                 return;
             }
        } else {
            if (signalToAddType === 'filter') {
                console.log(`Plotting existing filter signal: ${signalToAddName}`);
            } else {
                console.log(`Plotting base metric signal: ${signalToAddName}`);
            }
        }

        // Proceed to add the signal (either base metric or filter) to the plot
        if (signalToAddName && selectedColor) {
            addSignalToPlot(selectedLang, signalToAddName, selectedColor, showRaw, showShortMA, showLongMA, signalToAddType);
        } else {
             console.warn("Could not add signal - Final name or color missing?", { selectedLang, signalToAddName, selectedColor });
        }

        if (signalSelectorDiv) signalSelectorDiv.style.display = 'none';
    });


    timeWindowSelector?.addEventListener('change', () => {
        if (!timeWindowSelector) return; // Check inside listener
        const selectedHours = parseFloat(timeWindowSelector.value);
        if (!isNaN(selectedHours)) {
            setCurrentTimeWindowMs(selectedHours * HOUR_MS);
            requestHistoryData();
        }
    });

    console.log("Controls setup complete.");
}

/**
 * Adds a new signal configuration to the plottedSignals array and updates the UI/charts.
 * Updated to accept signal type.
 */
export function addSignalToPlot(langCode: string, signalName: string, color: string, showRaw: boolean, showShortMA: boolean, showLongMA: boolean, signalType: 'metric' | 'filter'): void {
    const newSignal: PlottedSignalConfig = {
        id: `${langCode}-${signalName}-${Date.now()}`,
        languageCode: langCode,
        signalName: signalName, // Use signalName
        type: signalType,      // Store the type
        color: color,
        showRaw: showRaw,
        showShortMA: showShortMA,
        showLongMA: showLongMA,
    };
    // Update duplicate check
    const isDuplicate = plottedSignals.some(s => s.languageCode === newSignal.languageCode && s.signalName === newSignal.signalName);

    if (!isDuplicate) {
        plottedSignals.push(newSignal);
        updatePlottedSignalsUI();
        requestHistoryData();
        console.log(`Added signal: ${signalName} (${langCode}, type: ${signalType})`);
    } else {
        console.log("Signal configuration (lang/signalName) already plotted.");
    }
}

/**
 * Updates the UI list showing currently plotted signals.
 */
export function updatePlottedSignalsUI() {
    if (!plottedSignalsListElement) {
        console.error("Cannot update plotted signals UI: element not found.");
        return;
    }
    plottedSignalsListElement.innerHTML = '';
    if (plottedSignals.length === 0) {
        plottedSignalsListElement.innerHTML = '<p>No signals added yet.</p>';
        return;
    }
    const ul = document.createElement('ul');
    // Clear existing list items before appending new ones
    // ul.innerHTML = ''; // This line is redundant as plottedSignalsListElement.innerHTML was just cleared
    plottedSignals.forEach(signal => {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.marginBottom = '4px';

        const swatch = document.createElement('span');
        swatch.style.cssText = `display:inline-block; width:12px; height:12px; background-color:${signal.color}; margin-right:8px; border:1px solid #ccc; flex-shrink: 0;`;

        const label = document.createElement('span');
        label.textContent = `${signal.signalName} (${signal.languageCode.toUpperCase()}) [${signal.type}]`; 
        label.style.flexGrow = '1';
        label.style.marginRight = '8px';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.className = 'remove-signal-btn';
        removeBtn.title = 'Remove Signal';
        removeBtn.style.padding = '0 4px';
        removeBtn.style.lineHeight = '1';
        removeBtn.style.border = '1px solid #ccc';
        removeBtn.style.background = '#eee';
        removeBtn.style.cursor = 'pointer';

        removeBtn.onclick = () => removeSignal(signal.id);

        li.appendChild(swatch);
        li.appendChild(label);
        li.appendChild(removeBtn);
        ul.appendChild(li);
    });
    plottedSignalsListElement.appendChild(ul);
}

/**
 * Removes a signal from the plottedSignals array and updates the UI and charts.
 */
export function removeSignal(signalId: string): void {
    console.log(`Removing signal with ID: ${signalId}`);
    const index = plottedSignals.findIndex(s => s.id === signalId);
    if (index > -1) {
        plottedSignals.splice(index, 1);
        updatePlottedSignalsUI();
        requestHistoryData();
    }
} 