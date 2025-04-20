# Bluesky Real-time Sentiment Analysis Dashboard - Development Plan

This document outlines the plan to build a real-time dashboard that monitors Bluesky posts, performs sentiment analysis using the NRC Emotion Lexicon, and displays emotion trends over time.

**Technology Stack:**

*   **Backend:** Node.js, TypeScript
*   **Frontend:** HTML, CSS, TypeScript (Plain JS initially)
*   **Real-time Communication:** WebSockets (`ws` or `socket.io`)
*   **Sentiment Analysis:** NRC Emotion Lexicon (Manual implementation required)
*   **Language Detection:** `franc`
*   **Charting:** Chart.js
*   **Deployment:** Fly.io (Docker)

**Project Phases:**

1.  **Project Setup (✅ Completed):**
    *   Initialize Node.js project (`npm init -y`).
    *   Set up TypeScript (`npm install -D typescript @types/node @types/ws`, created `tsconfig.json`).
    *   Install base dependencies (`npm install ws @atproto/api franc chart.js`).
    *   Set up project structure (`src/`, `public/`).

2.  **Bluesky Firehose Connection (✅ Completed):**
    *   Implemented a service module (`src/firehose.ts`) using `@atproto/xrpc-server`'s `Subscription` class to connect to the Bluesky Firehose.
    *   Handles `com.atproto.sync.subscribeRepos` method.
    *   Iterates through messages, decodes CAR files for commit events.
    *   Identifies and extracts `app.bsky.feed.post` records.
    *   Provides post records and commit metadata via a callback.
    *   Includes basic error handling and logging for the stream.

3.  **Data Filtering & Processing (✅ Completed):**
    *   Created the main server file (`src/server.ts`).
    *   Calls `subscribeToFirehose` from the server.
    *   Implemented the `processPost` callback function to receive posts.
    *   In the callback:
        *   Extracted post text.
        *   Used `franc` to detect language.
        *   Filtered out non-English posts.

4.  **Sentiment Analysis (NRC) (✅ Completed):**
    *   Created `src/sentiment.ts`.
    *   Created `data` directory and `data/NRC-Emotion-Lexicon-Wordlevel-v0.92.txt` placeholder/instruction file.
    *   Implemented lexicon loading logic in `src/sentiment.ts` to read and parse the lexicon file at startup.
    *   Implemented `analyzeSentiment` function to tokenize text and count emotions based on the loaded lexicon.
    *   Integrated `analyzeSentiment` into the `processPost` callback in `src/server.ts` for English posts.
    *   Sentiment scores are currently logged to the console.

5.  **Data Aggregation (✅ Completed):**
    *   Implemented an in-memory array (`aggregatedData`) in `src/server.ts` to store time-series sentiment scores.
    *   Created a temporary accumulator (`currentIntervalScores`) for incoming scores.
    *   Set up a `setInterval` timer (now 10 seconds) to run the `aggregateAndStore` function.
    *   The `aggregateAndStore` function adds accumulated scores with a timestamp to `aggregatedData` and resets the accumulator.
    *   Implemented pruning logic to remove data older than 12 hours from `aggregatedData`.
    *   Aggregated scores are currently logged to the console.

6.  **Real-time Backend (WebSockets) (✅ Completed):**
    *   Imported and initialized the `ws` library in `src/server.ts`.
    *   Created a `WebSocketServer` listening on `PORT` (default 8088).
    *   Implemented connection handling: sends the full `aggregatedData` history to new clients.
    *   Implemented a `broadcast` function to send data to all connected clients.
    *   Modified the `aggregateAndStore` timer function to call `broadcast` with the updated `aggregatedData` every 10 seconds.
    *   Added basic client disconnect and error logging.

7.  **Frontend Dashboard (✅ Completed):**
    *   Created `public/index.html` with HTML structure, CSS for grid layout, and canvas elements for 8 charts.
    *   Created `public/app.ts` with frontend logic.
    *   **Bundling:** Integrated `esbuild` to bundle frontend JS (`app.ts`) and its dependencies (`chart.js`, adapter) into `public/dist/app.js`.
    *   **Module Loading:** Configured `index.html` to load `app.js` as `type="module"`.
    *   **Functionality:** Frontend connects to WebSocket, receives aggregated data, initializes/updates 8 Chart.js line charts.
    *   Includes basic WebSocket reconnection logic.
    *   Updated `package.json` scripts for building backend (`tsc`) and frontend (`esbuild`).
    *   Removed `tsconfig.public.json` (handled by esbuild).

**Local Testing & Debugging (✅ Completed):**

*   Successfully ran the application locally after addressing several issues:
    *   Migrated backend (`src`) from CommonJS to ES Modules (`"type": "module"`, `tsconfig` changes, `import` syntax, `.js` extensions in imports) to resolve `ERR_REQUIRE_ESM` with `franc`.
    *   Corrected firehose message frame parsing in `src/firehose.ts` based on actual log data (`$type` field).
    *   Fixed HTTP server in `src/server.ts` to properly serve static files (`index.html`, bundled `app.js`) instead of only handling WebSocket upgrades.
    *   Changed default listening port to `8088` to avoid potential conflicts.
    *   Implemented firehose processing throttling (`1/50`) and adjusted aggregation interval (`10s`) for better local performance.
*   **Outcome:** Dashboard successfully renders charts with real-time data on `http://localhost:8088`.
*   **Limitation:** Current data aggregation is in-memory only; data is lost on server restart.

**Feature Enhancements (Phase 7 Follow-up):**

7.1. **Add Chart Smoothing (✅ Completed):**
    *   Modify Chart.js line dataset options in `public/app.ts` to enable line smoothing (e.g., `tension: 0.1`).

7.2. **Add Relative Time Labels (✅ Completed):**
    *   Installed Moment.js and `chartjs-adapter-moment`.
    *   Modify Chart.js x-axis scale options (`ticks.callback`, potentially `time.unit`, `time.stepSize`) in `public/app.ts` to display relative time labels (e.g., -2h, -1h, Now).

7.3. **Initialize Charts with Zero Data (✅ Completed):**
    *   **Frontend (`public/app.ts`):** Modified `public/app.ts` to generate an initial array of zero-score entries for the selected time window using the `AGGREGATION_INTERVAL_MS` constant.
    *   This zero data is displayed initially before the first WebSocket message arrives, providing a baseline.

7.4. **Implement Moving Time Window Display (✅ Completed):**
    *   Modify Chart.js x-axis scale options (`min`, `max`) in `public/app.ts` to be relative to the current time (e.g., `Date.now() - currentTimeWindowMs` to `Date.now()`).
    *   Ensure chart updates handle the moving window smoothly.

7.5. **Implement Time Range Selection Buttons (✅ Completed):**
    *   **Frontend (`public/index.html`):** Added buttons (12h, 6h, 2h, 1h, 15m) with basic styling.
    *   **Frontend (`public/app.ts`):**
        *   Added event listeners to buttons.
        *   Store the selected time window duration (`currentTimeWindowMs`).
        *   Modify `updateCharts` to use `currentTimeWindowMs` when setting `min` on the x-axis.
        *   Redraw charts with existing data (`currentChartData`) when the time range changes.

7.6. **Add Info Icon/Tooltip (✅ Completed):**
    *   Add an info icon (`<span>?</span>`) near the title in `public/index.html`.
    *   Add CSS in `public/index.html` (`<style>` tag) to style the icon and create a hover tooltip displaying the score calculation explanation (avg score per post within the 10s interval).

7.7. **Add Positive/Negative Sentiment Graph (✅ Completed):**
    *   **Backend (`src/sentiment.ts`):**
        *   Updated `SentimentScores` interface (previously `EmotionScores`) to include `positive` and `negative` fields.
        *   Modified lexicon loading to recognize `positive` and `negative` categories.
        *   Updated `analyzeSentiment` to count words associated with `positive` and `negative` sentiments.
    *   **Backend (`src/server.ts`):
        *   Updated `AggregatedScoreEntry` to use `SentimentScores`.
        *   Updated `createEmptyScores` and `addScores` helper functions to handle `positive` and `negative` fields.
        *   Modified `aggregateAndStore` to include the new scores in the broadcast data.
    *   **Frontend (`public/index.html`):**
        *   Added a new, full-width chart container (`div.chart-container.full-width`) at the top of the grid.
        *   Added a canvas (`id="chart-posneg"`) and title (`<h2>`) inside the new container.
    *   **Frontend (`public/app.ts`):**
        *   Updated `SentimentScores` and `AggregatedScoreEntry` interfaces.
        *   Modified `initializeCharts` to create a new Chart.js instance (`chartInstances['posneg']`) for the `chart-posneg` canvas, configured with a **single dataset** (Net Sentiment = Positive - Negative) and appropriate color/legend.
        *   Updated the y-axis configuration for the `posneg` chart to remove `beginAtZero: true`, allowing the axis to center around 0.
        *   Updated `initializeWithZeroData` to include `positive: 0, negative: 0` in the initial zero scores.
        *   Modified `updateCharts` to calculate normalized `positive` and `negative` scores, then compute a **net sentiment score** (`positive - negative`) for the single dataset, and update the `chartInstances['posneg']` chart data and time window.

7.8 **Add Moving Average Lines (5-min & 1-hour) (✅ Completed):**
    *   **Frontend (`public/app.ts`):**
        *   Defined constants for short (5min) and long (1h) moving average windows (`SHORT_AVG_POINTS`, `LONG_AVG_POINTS`).
        *   Implemented/verified `calculateMovingAverage` helper function.
        *   Modified `initializeCharts`:
            *   Each chart now has two datasets.
            *   Dataset 0: Labeled "5-min Avg", styled dashed/fainter.
            *   Dataset 1: Labeled "1-hour Avg", styled solid/prominent.
        *   Modified `updateCharts`:
            *   Calculates normalized 10s data as a base.
            *   Calculates both 5-minute and 1-hour moving averages for each emotion and net sentiment using the normalized data.
            *   Assigns 5-min MA to `datasets[0]` and 1-hour MA to `datasets[1]` for each chart.

8. **Add Database Persistence (Fly Postgres) (✅ Completed):**
    *   **Infrastructure:**
        *   Provisioned a Fly Postgres instance (`fly postgres create`).
        *   Attached the Postgres instance to the application (`fly postgres attach`), setting the `DATABASE_URL` secret.
    *   **Backend (`src/server.ts`):**
        *   Installed `pg` and `@types/pg` dependencies.
        *   Created a `pg.Pool` instance using `DATABASE_URL`.
        *   Implemented `initializeDatabase` function (called in `main`) to:
            *   Create `sentiment_data` table (timestamp TIMESTAMPTZ PK, scores JSONB, post_count INTEGER) if it doesn't exist.
            *   Create an index on the timestamp column.
        *   Removed the global in-memory `aggregatedData` array.
        *   Modified `aggregateAndStore` to:
            *   `INSERT` new `AggregatedScoreEntry` into `sentiment_data` table.
            *   Broadcast *only* the newly inserted entry (wrapped in an array) via WebSocket.
            *   Periodically `DELETE` old records (e.g., > 1 day) from the table.
        *   Modified WebSocket `connection` handler to:
            *   Query `sentiment_data` for the last 12 hours of data upon connection.
            *   Send the retrieved historical data to the new client.
    *   **Frontend (`public/app.ts`):**
        *   Updated WebSocket `onmessage` handler to differentiate between initial multi-entry historical data (replace `currentChartData`) and single-entry updates (push to `currentChartData`).
        *   Added optional pruning of the frontend `currentChartData` array.
    *   **Deployment:** Verified `Dockerfile` correctly runs `npm install`. Set `PORT=3000` environment variable via `fly secrets set` to match `fly.toml` `internal_port`.

9. **Update Time Range Options (15m-1mo) (✅ Completed):**
    *   **Frontend (`public/index.html`):
        *   Restored previous time range buttons (15m, 1h, 2h, 6h, 12h) alongside the new ones (1d, 1w, 1mo).
        *   Ensured `data-duration` attributes are correct for all buttons.
        *   Set 1d (24h) as the default active button.
    *   **Frontend (`public/app.ts`):
        *   Changed `DEFAULT_WINDOW_HOURS` constant to 24.
    *   **Backend (`src/server.ts`):**
        *   Defined constants for `ONE_MONTH_MS`, `MAX_HISTORY_MS`, `PRUNE_AGE_MS`.
        *   Updated WebSocket `connection` handler to query up to `MAX_HISTORY_MS` (1 month) from the database.
        *   Updated `aggregateAndStore` pruning logic to delete data older than `PRUNE_AGE_MS` (~31 days).
        *   Changed default `PORT` constant to 3000 to align with Fly configuration.

10. **Deployment Preparation (Fly.io) (✅ Completed):**
    *   Created a `Dockerfile` to containerize the application (multi-stage build).
    *   Includes steps to copy necessary files (`package.json`, `src`, `public`, `data`, compiled `dist`).
    *   Installs dependencies (`npm ci --include=dev` then `npm prune --omit=dev`).
    *   NRC Lexicon file included via `COPY . .`.
    *   Sets `CMD` to run the server (`npm start`).
    *   Created a `fly.toml` configuration file.
    *   Defined app name, primary region.
    *   Configured `http_service` (internal port set to 3000, `force_https=true`).
    *   Configured `auto_stop_machines = 'stop'`, `auto_start_machines = true`, `min_machines_running = 0` (later adjusted to 1).
    *   Created `.gitignore` (implicitly includes `.dockerignore` patterns).
    *   Set `PORT=3000` environment variable via `fly secrets set`.
    *   Provisioned and attached Fly Postgres database, setting `DATABASE_URL` secret.
    *   Configured for local development using `dotenv` and `fly proxy`.
    *   Adjusted `min_machines_running = 1` in `fly.toml` to prevent hibernation.

11. **Testing:**
    *   **TODO:** Add unit tests for sentiment analysis logic (`src/sentiment.ts`).
    *   **TODO:** Add unit tests for data aggregation/pruning logic (`src/server.ts`).
    *   **TODO:** Add basic integration tests for WebSocket communication (client connects, receives data).

12. **Deployment (✅ Completed):**
    *   Installed `flyctl` (Implicitly done by user).
    *   Launched the app on Fly.io (`fly launch`).
    *   Deployed the application (`fly deploy`).
    *   Monitored logs (`fly logs`) for debugging.

13. **Multi-Language Comparison (Server-Side Processing) (✅ Completed):**
    *   **Goal:** Allow users to select multiple languages and view their sentiment trends overlaid on the same charts, with aggregation and moving averages calculated efficiently on the backend.
    *   **Rationale:** Offloading aggregation and MA calculations to the server significantly reduces frontend load, improves performance (especially on long time scales), simplifies frontend logic, and aligns with common practices for time-series dashboards.
    *   **13.1 - 13.8: Backend Logic (✅ Completed):** Implemented multi-language lexicon loading, stemming, DB storage, server-side aggregation/MA calculation, and updated WebSocket protocol.
    *   **13.9 - 13.11: Frontend Logic (✅ Completed):** Implemented language selection UI, history request logic, and dynamic dataset handling to display multiple languages overlaid on 10 separate charts (Net Sentiment, Volume, 8 Emotions). Corrected normalization and MA calculations.

13.12 **Standardize MA Calculation Logic (✅ DONE):**
    *   **Backend (`src/server.ts`):** Modify historical MA calculation (`calculateSentimentMovingAverage`) to use the post-weighted average method (`Sum(scores) / Sum(postCount)` over the window), consistent with the live incremental calculation.
    *   **Goal:** Ensure live and historical MA values represent the same metric.

13.13 **Enable MA Calculation on Partial Windows (✅ DONE):**
    *   **Backend (`src/server.ts`):**
        *   Modify live MA calculation (`updateIncrementalWindowState`) to compute and return an average as long as the partial window has data (`state.queue.length > 0 && state.summedPostCount > 0`), instead of waiting for the full window.
        *   Modify historical MA calculation (`calculateSentimentMovingAverage`/`calculateNumericMovingAverage`) to compute and return an average at each point based on the available data within the sliding window up to that point, removing the check that waits for a full window.
    *   **Goal:** Eliminate `null` gaps in MA lines on the frontend, providing continuous visualization (accepting initial values represent partial windows).

14. **UI/UX Refactor: Dynamic Signal Plotting MVP (✅ DONE):**
    *   **Goal:** Improve usability by consolidating charts and allowing users to dynamically add specific signals (language + metric combination) to a main chart area.
    *   **14.1: Frontend - Simplify Chart Layout (`public/index.html`):**
        *   Reduce HTML to contain only two main canvas elements: `mainChart` (for line signals) and `volumeChart` (for stacked bars).
        *   Add a UI element (e.g., button `+ Add Signal`) to trigger signal selection.
        *   Add a hidden UI container (e.g., div `signalSelector`) with dropdowns (Language, Metric) and checkboxes (Raw, 5m MA, 1h MA) for defining a new signal to plot.
    *   **14.2: Frontend - Signal Management State (`public/app.ts`):**
        *   Introduce `plottedSignals` array state to store configurations of currently displayed signals.
        *   Refactor `initializeCharts` to only initialize `mainChart` and `volumeChart`.
    *   **14.3: Frontend - Signal Selection UI Logic (`public/app.ts`):**
        *   Implement event listeners for `+ Add Signal` button (to show selector) and confirm/cancel buttons within the selector.
        *   On confirm, add the new signal configuration to `plottedSignals` and trigger `requestHistoryData`.
        *   (Optional): Display the list of `plottedSignals` with remove buttons.
    *   **14.4: Frontend - Data Request Adaptation (`public/app.ts`):**
        *   Modify `requestHistoryData` to determine the set of unique languages required based on `plottedSignals`.
    *   **14.5: Frontend - Chart Data Refactor (`public/app.ts`):**
        *   Refactor `handleHistoryData` and `handleLiveUpdate`:
            *   Loop through `plottedSignals` instead of `selectedLanguages`.
            *   For `mainChart`, create/update datasets based on each signal's config (lang, metric, raw/MA visibility). Apply appropriate styling (e.g., raw faint, MAs dashed/solid).
            *   For `volumeChart`, create/update one dataset per unique language present in `plottedSignals`. Apply stacking and sorting (`sortVolumeDatasets`).
    *   **14.6: Backend - No Changes Needed (for MVP):** Existing backend functionality supports fetching required data.

15. **Lexicon Management, Dynamic Sentiment, & Advanced Filtering (⚪ To Do):**
    *   **Goal:** Integrate lexicon management directly into the application using a database, allow sentiment analysis to use custom/dynamic emotions, enable complex boolean keyword filtering, and refactor the backend API for better signal handling.
    *   **Sub-tasks:**
        *   **15.1: Design & Implement Lexicon DB Schema (⚪ To Do):**
            *   Define and create PostgreSQL tables (using `initializeDatabase` or a migration tool if adopted later):
                *   `lexicon_emotions` (emotion_id PK, emotion_name UNIQUE, is_base_nrc BOOLEAN)
                *   `lexicon_languages` (language_code PK UNIQUE, language_name) - Use lowercase NRC header names for code.
                *   `lexicon_words` (word_id PK, word_text, language_code FK, UNIQUE(word_text, language_code))
                *   `word_emotion_associations` (association_id PK, word_id FK, emotion_id FK, UNIQUE(word_id, emotion_id))
            *   **Add Indexes:** Ensure appropriate indexes are created on foreign keys and columns used in frequent lookups (e.g., `lexicon_words(word_text, language_code)`, `word_emotion_associations(word_id)`).
        *   **15.2: Implement Lexicon Ingestion Script (TypeScript) (⚪ To Do):**
            *   Create a standalone TypeScript script (`scripts/ingest_lexicon.ts`).
            *   Requires DB connection (`pg` client, reads `DATABASE_URL`).
            *   Reads `data/NRC-Emotion-Lexicon/NRC-Emotion-Lexicon-ForVariousLanguages.txt`.
            *   Parses the header to identify languages and base emotions.
            *   Populates the `lexicon_languages` and `lexicon_emotions` tables (setting `is_base_nrc=true`) using transactions.
            *   Iterates through data lines, populating `lexicon_words` and `word_emotion_associations` tables using transactions for integrity.
            *   Include in `package.json` scripts (e.g., `npm run ingest-lexicon`).
        *   **15.3: Implement Lexicon Management Script (Admin Only) (TypeScript) (⚪ To Do):**
            *   Create a script (`scripts/manage_lexicon.ts`) for admin use (direct execution on the backend).
            *   Provides functions for:
                *   `add_emotion(emotion_name)`: Adds a new row to `lexicon_emotions` (`is_base_nrc=false`).
                *   `add_word(word_text, language_code)`: Adds a word if it doesn't exist.
                *   `associate_word_emotion(word_text, language_code, emotion_name)`: Finds word/emotion IDs and creates an association in `word_emotion_associations`.
                *   `disassociate_word_emotion(...)`: Removes an association.
            *   (Note: No user-facing UI or API for lexicon management in this phase).
        *   **15.4: Refactor Sentiment Analysis for DB Lookups (`src/sentiment.ts`) (⚪ To Do):**
            *   Remove `loadConsolidatedNrcLexicon` function and file reading logic.
            *   Implement `loadDynamicEmotionsFromDB` (called at startup):
                *   Connects to DB.
                *   Queries `lexicon_emotions` to get the list of all current `emotion_name`s.
                *   Stores this list globally (e.g., `currentEmotionKeys: string[]`).
            *   Modify `analyzeSentiment`:
                *   Accept `text` and `langCode`.
                *   Tokenize and stem `text` as before.
                *   **Crucially:** For each `lookupToken`, query the database:
                    *   Find `word_id` from `lexicon_words` WHERE `word_text` = token AND `language_code` = langCode.
                    *   If found, query `word_emotion_associations` JOIN `lexicon_emotions` WHERE `word_id` = wordId.
                    *   Populate a dynamic `scores: Record<string, number>` object (initialized using `currentEmotionKeys` from `loadDynamicEmotionsFromDB`) based on the returned emotion names.
                *   **Performance Note:** This introduces DB lookups for each analyzed token. Assess performance impact. Consider optimizations like batching token lookups per post if needed.
            *   Potentially adjust `TARGET_LANGUAGES` map based on languages present in `lexicon_languages` table or keep as explicit filter.
        *   **15.5: Refactor Server Logic for Dynamic Scores (`src/server.ts`) (⚪ To Do):**
            *   Adapt `SentimentScores` usage (replace fixed interface with `Record<string, number>` or similar dynamic type) throughout the server logic (e.g., in `HistoryEntry`, `LiveUpdateEntry`, `WindowState`).
            *   Modify helper functions (`createEmptyScores`, `addScores`, `subtractScores`) to operate on the dynamic `Record<string, number>` structure, using the globally loaded `currentEmotionKeys` list.
            *   Ensure database storage/retrieval (`aggregateAndStore`, `getAggregatedData`) correctly handles the dynamic `scores` JSONB object.
            *   Ensure MA calculations (`calculateMAsForAggregatedData`, `updateIncrementalWindowState`) correctly handle the dynamic scores structure.
        *   **15.6: Expose Available Metrics Dynamically (Backend) (⚪ To Do):**
            *   Implement a simple, cached HTTP endpoint (e.g., `/api/metrics`) that queries `lexicon_emotions` and returns the list of available metrics (e.g., `[{ id: emotion_id, name: emotion_name }, ...]`) for the frontend.
        *   **15.7: Update Frontend Dynamically (`public/app.ts`) (⚪ To Do):**
            *   Remove hardcoded `AVAILABLE_METRICS` constant.
            *   On initialization, fetch the list of available metrics from the `/api/metrics` endpoint.
            *   Populate the metric selector dropdown (`#metricSelect`) dynamically.
            *   Ensure frontend logic (`getMetricValue`, dataset generation) correctly references metric names based on the fetched list.
        *   **15.8: Implement Complex Boolean Keyword Filters (Backend - Processing & Storage) (⚪ To Do):**
            *   **DB Schema:** Define and implement a table for storing admin-defined global filters: `complex_keyword_filters` (filter_id PK, filter_name UNIQUE, filter_query TEXT, description TEXT NULL). Query uses a defined syntax (e.g., maps to PostgreSQL `tsquery` or a custom format).
            *   **Admin Management:** Add functions to `scripts/manage_lexicon.ts` (or a new script) for admins to add/remove/update rows in `complex_keyword_filters`.
            *   **Filtering Logic:** Modify `processPost` (or add a filtering step):
                *   Load active filters from `complex_keyword_filters` at startup (or periodically).
                *   For each post, evaluate its text against each active filter's `filter_query`.
                *   **Library/Approach:** Investigate using PostgreSQL Full-Text Search (`tsquery` with `to_tsquery`, `ts_match_vq`) for efficient evaluation within the DB if possible. Alternatively, use a JS parsing library (`chevrotain`, `nearley`) or custom evaluation logic. Note performance impact.
            *   **Aggregation:** Implement separate aggregation for posts matching *each* filter. Create a new table `complex_filter_sentiment_data` (timestamp, filter_id FK, language, scores JSONB, post_count). Modify `aggregateAndStore` to update this table alongside `sentiment_data`.
        *   **15.9: Integrate Complex Filters into Signal Plotting (Frontend/Backend) (⚪ To Do):**
            *   **Backend:** Extend `/api/metrics` (or create `/api/filters`) to also return the list of available global complex filters (e.g., `[{ id: filter_id, name: filter_name, type: 'filter' }, ...]`).
            *   **Frontend:** Update the signal selection UI (`setupControls` in `public/app.ts`) to populate the metric/signal dropdown with both standard metrics and the available complex filters.
            *   **Backend:** Adapt `getAggregatedData` and `calculateMAsForAggregatedData` to handle requests for `filter_id`s, querying `complex_filter_sentiment_data` instead of `sentiment_data` and returning results in the same `HistoryEntry` format.
            *   **Frontend:** Adapt data request/handling (`requestHistoryData`, `handleHistoryData`, `handleLiveUpdate`) to request and display data for selected complex filter signals.
        *   **15.10: Backend API Refactor & Signal Composition Layer (⚪ To Do):**
            *   (As previously defined - This is a larger refactor, likely deferred until after the above dynamic features are stable. Focuses on request/response API, signal definitions, backend composition).

    *   **Future Considerations (Post-15):**
        *   **User-Facing Management:** UI/API for users (non-admins) to manage lexicons or define personal complex filters.
        *   **Frontend Validation:** Implementing robust frontend validation for complex filter syntax if user input is ever allowed.
        *   **Performance Optimization:** Further optimize DB lookups for sentiment analysis (e.g., caching frequent words) or filter evaluation if bottlenecks arise.
        *   **Global Custom Metrics Integration:** UI/Backend for *adding* custom metrics via an interface rather than just the admin script.