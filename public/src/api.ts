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

/**
 * Creates a new keyword filter signal on the backend.
 * @returns The definition (id, name, type) of the created/existing filter signal.
 */
export async function createKeywordFilterSignal(baseMetricKey: string, language: string, keywords: string): Promise<AvailableSignal | null> {
    console.log(`Creating keyword filter signal for metric: ${baseMetricKey}, lang: ${language}, keywords: "${keywords}"`);
    try {
        const response = await fetch('/api/filters', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ baseMetricKey, language, keywords }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response' }));
            console.error(`HTTP error creating filter! Status: ${response.status}`, errorData);
            throw new Error(errorData.error || `HTTP error ${response.status}`);
        }

        // Expect the backend to return fields compatible with AvailableSignal
        const createdFilter: AvailableSignal = await response.json(); 
        console.log('Successfully created/retrieved filter:', createdFilter);
        // Ensure the type is set correctly if the backend doesn't explicitly return it
        if (!createdFilter.type) {
            createdFilter.type = 'filter'; 
        }
        return createdFilter;

    } catch (error: any) {
        console.error("Error creating keyword filter signal:", error.message || error);
        alert(`Error creating filter: ${error.message || 'Unknown error'}`);
        return null;
    }
} 