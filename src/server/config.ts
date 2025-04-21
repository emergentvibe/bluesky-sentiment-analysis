export const AGGREGATION_INTERVAL_MS = parseInt(process.env.AGGREGATION_INTERVAL_MS || '10000', 10);
export const SHORT_AVG_WINDOW_POINTS = Math.max(1, Math.round(parseInt(process.env.SHORT_AVG_WINDOW_MS || (5 * 60 * 1000).toString(), 10) / AGGREGATION_INTERVAL_MS));
export const LONG_AVG_WINDOW_POINTS = Math.max(1, Math.round(parseInt(process.env.LONG_AVG_WINDOW_MS || (60 * 60 * 1000).toString(), 10) / AGGREGATION_INTERVAL_MS));
export const DEFAULT_METRIC_KEYS = ['positive', 'negative'];
export const LIVE_UPDATE_BUFFER_MS = parseInt(process.env.LONG_AVG_WINDOW_MS || (60 * 60 * 1000).toString(), 10) + (5 * 60 * 1000);

// Consider adding other config-related values like PORT, DATABASE_URL validation/defaults, etc.
// For now, only moving the explicitly identified constants. 