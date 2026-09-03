# API Review for Grafana Integration

This document reviews the existing API touchpoints of the Bluesky Sentiment Analysis application and discusses changes or considerations for transitioning to a Grafana frontend that polls the database.

## Current API Endpoints/Interfaces

The application currently has a few types of interfaces:

1.  **HTTP API Endpoints (Backend - `src/server/httpServer.ts`):**
    *   **`/api/metrics` (or `/api/signals` as planned):**
        *   **Current Purpose:** Serves a list of available metrics for the custom frontend to populate its signal selector. This list includes dynamic emotions (from `lexicon_emotions` table) and active complex keyword filters (from `complex_keyword_filters` table).
        *   **Structure (Assumed):** Likely returns a JSON array, e.g.:
            ```json
            [
              { "id": "emotion_joy", "name": "Joy", "type": "emotion", "language_independent": true },
              { "id": "emotion_anger", "name": "Anger", "type": "emotion", "language_independent": true },
              { "id": "filter_xyz", "name": "My Custom Filter XYZ", "type": "filter", "language_independent": false }
              // ... and so on
            ]
            ```
        *   **Also serves available languages:** The dev plan also implies that language lists might be part of this or a similar mechanism for the frontend.

    *   **Static File Serving:** The HTTP server also serves the static files for the custom frontend (e.g., `index.html`, `public/dist/app.js`).

2.  **WebSocket API (Backend - `src/server/websocketServer.ts`):**
    *   **Current Purpose:** Provides real-time communication with the custom frontend.
        *   **Initial Data:** Sends historical aggregated data upon a new client connection (client sends a `requestHistory` type message).
        *   **Live Updates:** Broadcasts newly aggregated data points (including raw scores and MAs) to all connected clients.
    *   **Message Format:** Uses a custom JSON-based message format for these interactions.

3.  **Database Schema (PostgreSQL):**
    *   **Implicit API:** The structure of tables like `sentiment_data`, `complex_filter_sentiment_data`, `lexicon_emotions`, `lexicon_languages`, `complex_keyword_filters`, and how MAs are stored, effectively forms an API for any system that queries it directly. Grafana would be such a system.

4.  **Admin Scripts (`scripts/` directory):**
    *   `ingest_lexicon.ts`, `manage_lexicon.ts`, `manage_filters.ts`: These are not runtime APIs for the frontend but are crucial for data management and system setup. They interact directly with the database.

## Changes and Considerations for Grafana

With Grafana as the frontend, relying on direct database polling:

1.  **HTTP API Endpoints:**
    *   **`/api/metrics` (or `/api/signals`):**
        *   **Option A: Keep and Use for Grafana Variables:** Grafana *can* be configured to fetch data for its template variables (dropdowns for language, signal type, etc.) from an HTTP JSON API.
            *   **Pro:** If this API is well-structured and already provides all necessary metadata (e.g., list of languages, list of emotion names, list of filter names, perhaps even their corresponding database table/column names or query patterns), it could simplify Grafana variable setup.
            *   **Con:** It's another component to maintain. Grafana is also very capable of populating variables directly from SQL queries against the database.
            *   **Change Needed:** Ensure the output format is easily consumable by Grafana's "JSON API" data source or a UQL query if using the Infinity plugin. The current structure might need slight adjustments (e.g., ensuring distinct `__text` and `__value` fields if Grafana's standard JSON variable query expects it).
        *   **Option B: Deprecate and Use Direct DB Queries in Grafana:** This is often the more common and straightforward approach with Grafana.
            *   **Pro:** Simplifies the backend by removing an API endpoint maintained primarily for frontend metadata. Grafana directly queries the source of truth (the database) for variable options.
            *   **Change Needed (Backend):** The API endpoint can be removed.
            *   **Change Needed (Grafana):** Configure Grafana template variables with SQL queries:
                *   Language Variable: `SELECT language_name AS __text, language_code AS __value FROM lexicon_languages ORDER BY __text;`
                *   Signal Variable:
                    ```sql
                    SELECT emotion_name AS __text, emotion_name AS __value, 'emotion' AS signal_type FROM lexicon_emotions
                    UNION ALL
                    SELECT filter_name AS __text, filter_name AS __value, 'filter' AS signal_type FROM complex_keyword_filters WHERE is_active = TRUE
                    ORDER BY __text;
                    ```
                *   MA Type Variable (if desired): Could be a "Custom" type variable in Grafana (e.g., values: `Raw,5 Min MA,1 Hour MA`).
        *   **Recommendation:** Lean towards **Option B (Direct DB Queries in Grafana)** for populating variables, as it simplifies the backend application API surface. However, if the existing API is robust and easy for Grafana to consume, Option A is also viable. Phase 17.2 reflects this choice.

    *   **Static File Serving:**
        *   **Change Needed:** This functionality will be entirely removed from the Node.js backend. Grafana serves its own frontend.

2.  **WebSocket API:**
    *   **Change Needed:** This entire API and its implementation (`src/server/websocketServer.ts`, broadcasting logic in `aggregateAndStore`, etc.) will be **removed**. Grafana will use polling against the database, not WebSockets.

3.  **Database Schema (The New Primary "API" for Visualization):**
    *   **Data Structure for Scores & MAs:**
        *   How scores (emotions, positive/negative) are stored in the JSONB `scores` field within `sentiment_data` and `complex_filter_sentiment_data` needs to be easily queryable by Grafana. Grafana's PostgreSQL queries will need to extract specific keys from this JSONB object.
            *   Example query snippet for Grafana: `(scores->>'joy')::numeric AS joy_score`
        *   How Moving Averages are stored needs to be clear. Are they separate columns? Or also within the JSONB object?
            *   If in JSONB: `(scores->>'joy_5m_ma')::numeric AS joy_5m_ma`
            *   If separate columns: `joy_5m_ma AS joy_5m_ma` (Simpler for Grafana queries).
        *   **Change Needed (Potentially):** If MAs are currently nested deeply in JSON or not easily selectable as distinct series, a minor refactor of the database storage for MAs might simplify Grafana queries. Storing MAs as top-level keys in the JSONB or as separate columns in the `sentiment_data` / `complex_filter_sentiment_data` tables would be ideal. The dev plan mentions "MA Storage & Queryability" (17.3) which should cover this.
    *   **Table for Signal Mapping:** Grafana queries will need to join or map selected "Signal" variables to the correct data (e.g., a specific key in the `scores` JSONB in `sentiment_data`, or a specific filter ID to query `complex_filter_sentiment_data`). The `signal_type` added to the Signal Variable query example above helps differentiate.
    *   **Timestamps:** Ensure `timestamp` columns are consistently `TIMESTAMPTZ` and well-indexed. Grafana relies heavily on these for time-series data.

4.  **Admin Scripts:**
    *   **No Change Needed:** These scripts operate on the database directly and are not directly part of the Grafana data consumption API. They remain essential for managing the underlying data Grafana will use.

## Summary of API-Related Tasks for Grafana Transition (aligns with Phase 17):

*   **Remove:** WebSocket server and all associated client communication logic.
*   **Remove:** Static frontend file serving from the Node.js HTTP server.
*   **Decide:** Whether to keep/adapt the `/api/signals` endpoint for Grafana variables or remove it in favor of direct database queries within Grafana for variable population (recommended).
*   **Review & Optimize:** Database schema, especially how sentiment scores and MAs are stored within `sentiment_data` and `complex_filter_sentiment_data` tables, to ensure they are easily and performantly queryable by Grafana as distinct time series. Ensure robust indexing.
*   **Document:** SQL query patterns for Grafana to:
    *   Populate template variables (languages, signals).
    *   Fetch time-series data for emotions/filters, including their raw scores and various MAs, based on selected variables.

The transition essentially shifts the "data consumption API" for visualization from a custom WebSocket + HTTP API to the SQL interface of the PostgreSQL database, with an optional small HTTP API for metadata if preferred over direct DB queries for Grafana variables. 