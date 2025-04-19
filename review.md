# Bluesky Sentiment Analysis Dashboard - Code Review

This document provides a review of the architecture, functionality, and design of the Bluesky Real-time Sentiment Analysis Dashboard codebase.

## Overall Architecture

The system follows a standard client-server architecture:

1.  **Backend (Node.js/TypeScript):** Responsible for connecting to the Bluesky Firehose, processing incoming posts, performing sentiment analysis, aggregating data, storing results in a database, and serving the frontend application. It communicates with the frontend in real-time using WebSockets.
2.  **Database (PostgreSQL):** Persists the aggregated sentiment data over time, allowing for historical analysis.
3.  **Frontend (HTML/CSS/TypeScript):** A single-page web application that displays the sentiment data using Chart.js. It connects to the backend via WebSockets to receive historical data and live updates.

## Component Breakdown

### Backend (`src/`)

#### `src/firehose.ts`

*   **Purpose:** Establishes and manages the WebSocket subscription to the Bluesky Firehose (`com.atproto.sync.subscribeRepos`). It listens for repository commit events, filters for relevant post creation/update operations, parses the CAR file data using `@atproto/repo` utilities, and extracts post records (`app.bsky.feed.post`).
*   **Functionality:** Uses the `@atproto/xrpc-server` `Subscription` class. Includes basic validation (`validate`) to filter relevant commit messages. Passes valid post records and commit metadata to a callback function (`processPost` in `server.ts`).
*   **Strengths:**
    *   Encapsulates the firehose connection logic separately from the main server logic.
    *   Uses official `@atproto` libraries for reliable connection and parsing.
    *   Provides a clean callback interface (`PostCallback`) for decoupling.
*   **Areas for Improvement:**
    *   **Error Handling:** The main `try...catch` block around the subscription loop is good, but more granular error handling within the loop (e.g., for `readCar`, `cborToLexRecord`) could prevent one bad commit from stopping the processing of subsequent valid ops within that commit. Consider logging problematic `commit.repo` more consistently on errors.
    *   **Reconnection Logic:** While `@atproto/xrpc-server` might handle some reconnection, the current code doesn't explicitly define robust retry/backoff logic if the initial connection fails or the subscription drops unexpectedly (apart from logging).
    *   **Type Safety:** Some use of `any` (e.g., `commit as any`) could potentially be tightened, although interacting with generic XRPC structures can make this challenging.

#### `src/sentiment.ts`

*   **Purpose:** Handles language detection, lexicon loading, stemming (where available), and sentiment scoring based on the NRC Emotion Lexicon.
*   **Functionality:**
    *   Loads a consolidated NRC lexicon file, parsing multiple languages from a TSV format.
    *   Initializes stemmers for supported languages using the `natural` library.
    *   Maps `franc` language codes to lexicon language names (`TARGET_LANGUAGES`).
    *   The `analyzeSentiment` function takes text and a language code, performs tokenization, optional stemming, and lexicon lookup to return `SentimentScores` (or `null` if unsupported).
*   **Strengths:**
    *   Supports multiple languages based on the provided lexicon.
    *   Separates sentiment analysis logic clearly.
    *   Handles stemmer initialization dynamically based on availability.
    *   Correctly loads the English lexicon from the first column.
*   **Areas for Improvement:**
    *   **Lexicon Loading Robustness:** Error handling during file reading is good, but parsing assumes a strict TSV format. More validation could be added. The header parsing relies on fixed column indices (1-10 for emotions) which could break if the file format changes.
    *   **Stemmer Management:** Relies on the structure of the `natural` library's default export. If the library changes, this might break. Logging could indicate *which* specific stemmers failed to load.
    *   **Performance:** Loading and parsing the large lexicon file happens synchronously on startup. For very large lexicons or slower filesystems, this could increase startup time. Consider asynchronous loading or pre-processing.
    *   **Extensibility:** Adding new lexicons or sentiment scoring methods would require significant modification. A more pluggable design could be beneficial long-term.

#### `src/server.ts`

*   **Purpose:** The main orchestrator. Sets up the HTTP server (to serve frontend files), the WebSocket server (for real-time communication), initializes the database, connects to the Firehose (via `firehose.ts`), defines data processing/aggregation logic (`processPost`, `aggregateAndStore`), handles client requests (`requestHistory`), and manages data buffers.
*   **Functionality:**
    *   Serves static files from `public/`.
    *   Manages WebSocket connections (`wss`).
    *   Parses incoming WebSocket messages (`requestHistory`).
    *   Receives posts from `firehose.ts` via the `processPost` callback.
    *   Detects language (`franc`), calls `analyzeSentiment`.
    *   Accumulates scores/counts per language in `currentInterval*` variables.
    *   Periodically (`AGGREGATION_INTERVAL_MS`), `aggregateAndStore`:
        *   Saves aggregated data to PostgreSQL.
        *   Maintains/prunes an in-memory `recentHistoryBuffer`.
        *   Calculates latest MAs using the buffer (`calculateSentimentMovingAverage`).
        *   Broadcasts `liveUpdate` messages (including latest MAs) to clients.
    *   Handles `requestHistory`:
        *   Queries PostgreSQL (`getAggregatedData`) for the requested time range/languages/interval.
        *   Calculates MAs on the historical data (`calculateMAsForAggregatedData`).
        *   Sends the results back to the requesting client.
    *   Includes database pruning logic.
*   **Strengths:**
    *   Combines multiple functionalities logically (HTTP, WS, DB, Aggregation).
    *   Uses TypeScript and `async/await`.
    *   Implements both historical data retrieval and live updates.
    *   Includes MA calculation for both history and live data.
    *   Environment variable usage (`dotenv`) for configuration.
    *   Clear separation between interval accumulation and periodic storage/broadcast.
*   **Areas for Improvement:**
    *   **Complexity:** This file is quite large and handles many distinct tasks. Consider breaking it down further:
        *   Separate module for WebSocket message handling/routing.
        *   Separate module for database interactions (repository pattern?).
        *   Separate module for aggregation/MA logic.
    *   **Configuration:** Many constants (intervals, window sizes, buffer sizes) are hardcoded at the top. Centralizing these in a config file or object would improve maintainability.
    *   **Error Handling:** DB query errors are caught but often just logged; more specific handling might be needed (e.g., informing the client on history request failure). WebSocket send errors are logged but not acted upon.
    *   **Buffer Management:** The `recentHistoryBuffer` could grow large. While pruning exists, a more robust buffer implementation (e.g., fixed-size circular buffer, dedicated library) might be more memory-efficient. Sorting the buffer on every insertion (`aggregateAndStore`) could be inefficient for large buffers.
    *   **Type Safety:** Uses `any` in several places (error handling, `CommitData`, message parsing). Stricter typing would improve robustness.
    *   **Static File Serving:** Basic manual file serving works but could be replaced by using a simple framework like Express for more standard routing and middleware capabilities.
    *   **MA Calculation:** The logic to calculate MAs separately for history (in `calculateMAsForAggregatedData`) and live (in `aggregateAndStore`) involves some repetition. Refactoring might consolidate this.

### Database (PostgreSQL)

*   **Purpose:** Stores time-series aggregated sentiment data per language.
*   **Schema:** A single table `sentiment_data` with `timestamp` (TIMESTAMPTZ), `language` (VARCHAR), `scores` (JSONB), and `post_count` (INTEGER). Composite primary key on `(timestamp, language)`. Index on `timestamp`.
*   **Strengths:**
    *   Simple and effective schema for the current needs.
    *   Uses appropriate data types (`TIMESTAMPTZ`, `JSONB`).
    *   Indexing on `timestamp` is crucial for time-based queries.
    *   `ON CONFLICT DO NOTHING` handles potential duplicate writes gracefully during aggregation.
*   **Areas for Improvement:**
    *   **Indexing:** If filtering/grouping by `language` becomes frequent in queries, an index on `(language, timestamp)` might improve performance.
    *   **Scalability:** For extremely high volumes, partitioning the table by time might be necessary, but likely overkill currently.
    *   **Pruning:** The current pruning (`aggregateAndStore` with `Math.random() < 0.05`) is non-deterministic. A scheduled job (e.g., cron, or a more reliable timer within the app) would be better for production.
    *   **Schema Migrations:** No migration system is present. For production or team environments, tools like `node-pg-migrate` would be needed to manage schema changes reliably.

### Frontend (`public/`)

*   **Purpose:** Provides the user interface for visualizing sentiment data.
*   **Functionality (`public/app.ts`):**
    *   Initializes multiple Chart.js charts (Net Sentiment, Volume, individual emotions).
    *   Manages WebSocket connection lifecycle (connect, open, message, error, close, reconnect).
    *   Handles incoming `historyData` and `liveUpdate` messages.
    *   Processes received data: normalizes raw scores per post, plots raw scores and MAs directly.
    *   Updates chart datasets dynamically based on received data and selected languages/time window.
    *   Manages UI controls (language selector, time window dropdown) and triggers data requests on changes.
    *   Uses helper functions for creating chart datasets and getting colors.
*   **Structure (`public/index.html`):**
    *   Standard HTML structure.
    *   Includes canvas elements for each chart.
    *   Defines control elements (dropdown, div for checkboxes).
    *   Includes the bundled `app.js`.
    *   CSS is embedded within `<style>` tags.
*   **Strengths:**
    *   Uses Chart.js effectively for visualization.
    *   Written in TypeScript.
    *   Clear separation of concerns via functions (`initializeCharts`, `handleHistoryData`, `handleLiveUpdate`, `setupControls`).
    *   Handles WebSocket communication and basic reconnection.
    *   Dynamically updates UI based on backend data and user interaction.
    *   Correctly normalizes raw scores and plots MAs.
*   **Areas for Improvement:**
    *   **Framework:** Lacks a modern frontend framework (React, Vue, Svelte). State management relies on global variables (`chartInstances`, `selectedLanguages`, `currentTimeWindowMs`), which can become difficult to manage as complexity grows. A framework would provide better structure, state management, and component reuse.
    *   **CSS:** Embedding CSS in HTML is not ideal for larger applications. Moving styles to a separate `.css` file (or using CSS-in-JS/modules with a framework) is recommended.
    *   **Error Handling:** WebSocket message parsing has a basic `try...catch`, but specific error states (e.g., backend sends malformed data) aren't explicitly handled for the user.
    *   **Performance:** Frequent chart updates (`updateCharts`) could potentially cause lag on lower-end machines, especially with many datasets visible. Debouncing control inputs could prevent excessive history requests. Chart.js performance tuning options could be explored.
    *   **Type Safety:** Uses `any` in places (e.g., dataset manipulation, scale options). Tighter typing is possible.
    *   **Build Process:** Relies on a simple `npm run build` (likely `esbuild` or similar). More complex build requirements might necessitate a tool like Webpack or Vite.

## Interaction Flow

1.  **Initialization:**
    *   Backend starts, initializes DB, connects to Firehose.
    *   Frontend loads, initializes charts (`initializeCharts`), sets up controls (`setupControls`), connects WebSocket (`connectWebSocket`).
2.  **Initial Data Load:**
    *   Frontend WebSocket connects (`onopen`), calls `requestHistoryData`.
    *   Backend receives `requestHistory`, calls `getAggregatedData` (queries DB), calls `calculateMAsForAggregatedData`, sends `historyData` message back.
    *   Frontend receives `historyData`, calls `handleHistoryData` to populate charts.
3.  **Live Processing:**
    *   Backend (`firehose.ts`) receives commit, extracts post, calls `processPost`.
    *   `processPost` detects language, analyzes sentiment, adds to `currentInterval*` accumulators.
    *   Every 10s, `aggregateAndStore` runs:
        *   Saves data to DB.
        *   Updates/prunes `recentHistoryBuffer`.
        *   Calculates latest MAs from buffer.
        *   Broadcasts `liveUpdate` (with scores and MAs).
    *   Frontend receives `liveUpdate`, calls `handleLiveUpdate`:
        *   Normalizes raw scores, uses MAs directly.
        *   Adds new points to relevant datasets.
        *   Calls `updateCharts`.
4.  **User Interaction:**
    *   User changes time window/language selection.
    *   Frontend updates state (`currentTimeWindowMs`, `selectedLanguages`), calls `requestHistoryData`.
    *   Flow proceeds like Initial Data Load.

## Overall Design Comments

*   **Strengths:** The overall design is logical and achieves the core goal of real-time sentiment display. The separation into backend, frontend, and distinct backend modules (`firehose`, `sentiment`) is good practice. The use of WebSockets for real-time updates and a database for historical data is appropriate. The event-driven nature (Firehose -> Processing -> Aggregation -> Broadcast/Save) is suitable for this type of application.
*   **Weaknesses:** The primary weaknesses lie in areas typical of projects evolving organically: increasing complexity within single files (`server.ts`, `app.ts`), manual state management on the frontend, basic error handling, and lack of infrastructure for production concerns (migrations, deterministic pruning, robust configuration). Type safety could be improved by reducing `any`.

## Future Enhancement Ideas

*   **Refactor `server.ts`:** Break down logic into smaller, more focused modules.
*   **Introduce Frontend Framework:** Adopt React, Vue, or Svelte for better state management, componentization, and maintainability.
*   **Configuration Management:** Move constants to a dedicated config file/service.
*   **Robust Error Handling:** Implement more specific error catching, logging levels, and potentially user feedback mechanisms (e.g., connection status indicators). Add Firehose reconnect/backoff logic.
*   **Database Migrations:** Integrate a migration tool.
*   **Deterministic Pruning:** Replace random pruning check with a scheduled task.
*   **UI/UX Improvements:** Debounce controls, add loading indicators, potentially optimize chart rendering.
*   **Testing:** Introduce unit and integration tests for backend logic (especially sentiment analysis, aggregation, MA calculation) and potentially end-to-end tests. 