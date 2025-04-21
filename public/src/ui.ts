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
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'block';
    });

    cancelSignalBtn?.addEventListener('click', () => {
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'none';
    });

    // Attach confirm button listener - check elements *inside* callback
    confirmSignalBtn?.addEventListener('click', () => {
        console.log("Confirm Signal Button clicked!");

        // Check required elements INSIDE the listener scope
        if (!langSelect || !availableSignalsList || !signalColorInput || !showRawCheckbox || !showShortMACheckbox || !showLongMACheckbox) {
             console.error("Cannot confirm signal: One or more required configuration elements are missing at click time.");
             return;
        }

        const selectedLang = langSelect.value; // Safe now due to check above
        const selectedSignalRadio = availableSignalsList.querySelector('input[name="availableSignal"]:checked') as HTMLInputElement | null; // Safe now due to check above

        if (!selectedSignalRadio) {
            console.warn("Could not add signal - No metric selected.");
            return;
        }
        const selectedMetric = selectedSignalRadio.value;
        const selectedColor = signalColorInput.value; // Safe now due to check above
        const showRaw = showRawCheckbox.checked; // Safe now due to check above
        const showShortMA = showShortMACheckbox.checked; // Safe now due to check above
        const showLongMA = showLongMACheckbox.checked; // Safe now due to check above

        // selectedLang is guaranteed by the initial check inside the handler
        if (selectedMetric && selectedColor) { 
            addSignalToPlot(selectedLang, selectedMetric, selectedColor, showRaw, showShortMA, showLongMA);
        } else {
             // This case should be less likely now
             console.warn("Could not add signal - Metric or Color missing?", { selectedLang, selectedMetric, selectedColor });
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
 */
export function addSignalToPlot(langCode: string, metric: string, color: string, showRaw: boolean, showShortMA: boolean, showLongMA: boolean): void {
    const newSignal: PlottedSignalConfig = {
        id: `${langCode}-${metric}-${Date.now()}`,
        languageCode: langCode,
        metric: metric,
        color: color,
        showRaw: showRaw,
        showShortMA: showShortMA,
        showLongMA: showLongMA,
    };
    const isDuplicate = plottedSignals.some(s => s.languageCode === newSignal.languageCode && s.metric === newSignal.metric);

    if (!isDuplicate) {
        plottedSignals.push(newSignal);
        updatePlottedSignalsUI();
        requestHistoryData();
        console.log(`Added signal: ${metric} (${langCode})`);
    } else {
        console.log("Signal configuration (lang/metric) already plotted.");
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
    plottedSignals.forEach(signal => {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.marginBottom = '4px';

        const swatch = document.createElement('span');
        swatch.style.cssText = `display:inline-block; width:12px; height:12px; background-color:${signal.color}; margin-right:8px; border:1px solid #ccc; flex-shrink: 0;`;

        const label = document.createElement('span');
        label.textContent = `${signal.metric} (${signal.languageCode.toUpperCase()})`;
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