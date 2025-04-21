// --- Time Window Configuration ---
export const DEFAULT_WINDOW_HOURS = 24; // Initial time range displayed.
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

// --- WebSocket Configuration ---
export const MAX_RECONNECT_ATTEMPTS = 5;
export const INITIAL_RECONNECT_DELAY = 5000; // 5 seconds
export const MAX_RECONNECT_DELAY = 30000; // 30 seconds
export const AGGREGATION_INTERVAL_MS = 10000; // 10 seconds (should match backend)

// --- Language Configuration ---
export const AVAILABLE_LANGUAGES: { code: string, name: string }[] = [
    { code: 'eng', name: 'English' },
    { code: 'fra', name: 'French' },
    { code: 'spa', name: 'Spanish' },
    { code: 'ita', name: 'Italian' },
    { code: 'nld', name: 'Dutch' },
    { code: 'por', name: 'Portuguese' },
    { code: 'swe', name: 'Swedish' },
    { code: 'nob', name: 'Norwegian' },
    { code: 'rus', name: 'Russian' },
    { code: 'deu', name: 'German' },
    { code: 'cmn', name: 'Chinese (Simp)' },
    { code: 'jpn', name: 'Japanese' },
    { code: 'ara', name: 'Arabic' },
    { code: 'pol', name: 'Polish' },
    { code: 'tur', name: 'Turkish' },
    { code: 'vie', name: 'Vietnamese' },
    { code: 'kor', name: 'Korean' },
    { code: 'ind', name: 'Indonesian' },
    { code: 'hin', name: 'Hindi' },
    { code: 'ben', name: 'Bengali' }
];

// --- Color Configuration ---
export const baseColors = [
    'rgba(54, 162, 235, 1)',   // Blue
    'rgba(255, 99, 132, 1)',   // Red
    'rgba(75, 192, 192, 1)',   // Teal
    'rgba(255, 206, 86, 1)',   // Yellow
    'rgba(153, 102, 255, 1)', // Purple
    'rgba(255, 159, 64, 1)',  // Orange
    'rgba(100, 180, 120, 1)', // Green
    'rgba(201, 203, 207, 1)'  // Grey
]; 