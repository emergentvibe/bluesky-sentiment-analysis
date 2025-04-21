import {
    Chart,
    registerables,
} from 'chart.js';
import 'chartjs-adapter-moment'; // Import the adapter
// No need to import moment here if only used by chart.ts

// Import modules
import * as State from './src/state.ts'; // Keep unused state imports if needed elsewhere, or remove
import * as Config from './src/config.ts'; // Keep unused config imports if needed elsewhere, or remove
import * as DOM from './src/dom.ts';
import { fetchAvailableSignals } from './src/api.ts';
import { connectWebSocket } from './src/websocket.ts';
import { initializeCharts } from './src/chart.ts';
import { setupControls, updatePlottedSignalsUI } from './src/ui.ts';

// Register necessary Chart.js components globally
Chart.register(...registerables);

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded - Initializing...');

    // --- Assign DOM Elements ---
    DOM.assignDOMElements(); // Call the assignment function from dom.ts

    // --- Basic Check for Critical Elements ---
    // Check elements via the DOM module after assignment
    if (!DOM.plottedSignalsListElement || !DOM.addSignalBtn || !DOM.signalSelectorDiv) {
        console.error("CRITICAL: Essential UI elements for signal management not found! Check IDs in index.html.");
        if (DOM.loadingIndicator) DOM.loadingIndicator.textContent = "Error loading UI components.";
        return; // Stop initialization if critical elements are missing
    }

    // Show loading indicator
    if (DOM.loadingIndicator) DOM.loadingIndicator.style.display = 'block';

    // --- Application Setup ---
    try {
        await fetchAvailableSignals(); // Fetch dynamic signal list
        initializeCharts();         // Create chart instances
        setupControls();            // Populate selectors, add event listeners
        updatePlottedSignalsUI();   // Update UI based on initial state
        connectWebSocket();         // Establish WebSocket connection
    } catch (error) {
        console.error("Error during application initialization:", error);
        if (DOM.loadingIndicator) {
            DOM.loadingIndicator.textContent = "Error initializing application.";
            DOM.loadingIndicator.style.color = 'red';
        }
    }

    // Hide loading indicator once setup (or error handling) is complete
    if (DOM.loadingIndicator) DOM.loadingIndicator.style.display = 'none';

    console.log("Application Initialization Complete.");
});

// Removed all old function definitions and standalone variable declarations
