import { AvailableSignal } from './types.ts';
import { availableSignals } from './state.ts';

/**
 * Fetches the list of available metrics AND filters from the backend.
 * Updates the global `availableSignals` state.
 */
export async function fetchAvailableSignals(): Promise<void> {
    console.log("Fetching available signals from /api/metrics...");
    try {
        const response = await fetch('/api/metrics');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data: AvailableSignal[] = await response.json();
        // Directly modify the imported state array. This is often discouraged,
        // but for this refactoring, we keep it simple.
        // A more robust solution might involve returning the data and having
        // the main app logic update the state.
        availableSignals.length = 0; // Clear existing array
        availableSignals.push(...data); // Push new items

        console.log("Available signals loaded:", availableSignals);
        if (availableSignals.length === 0) {
             console.warn("Warning: No available signals (metrics/filters) received from backend.");
        }
    } catch (error) {
        console.error("Error fetching available signals:", error);
        availableSignals.length = 0; // Ensure it's empty on error
    }
} 