# Directory and File Outline

This document outlines the structure of the Bluesky Real-time Sentiment Analysis project, focusing on its current backend architecture for Grafana integration.

```
.
├── Dockerfile            # Defines the container image for deployment (e.g., on Fly.io).
├── docker-compose.yml    # Defines and configures services (backend, postgres, grafana) for local development.
├── fly.toml              # Configuration file for Fly.io deployment.
├── package.json          # Node.js project manifest: lists dependencies and scripts.
├── package-lock.json     # Records exact versions of installed dependencies.
├── tsconfig.json         # TypeScript compiler configuration for the backend.
├── .env.example          # Example environment variables file. Copy to .env for local setup.
├── .env                  # Local environment variables (e.g., DATABASE_URL). (Untracked by Git).
├── .gitignore            # Specifies intentionally untracked files that Git should ignore.
├── .dockerignore         # Specifies files to ignore when building the Docker image.
├── README.md             # General information and setup instructions for the project.
├── LICENSE               # Project's license file.
│
├── data/                 # (Potentially Obsolete) Contains static data files.
│   └── NRC-Emotion-Lexicon-Wordlevel-v0.92.txt # Original lexicon file (lexicon now managed in DB).
│
├── dist/                 # Output directory for compiled backend TypeScript code (from `tsc`).
│   └── src/              # Contains compiled JavaScript files.
│
├── docs/                 # Contains project documentation.
│   ├── dev-plan.md       # Outlines the development plan, phases, and feature status (incl. Grafana).
│   ├── SETUP.md          # Instructions for setting up the project for local development.
│   ├── directory-outline.md # This file - outlines the project structure.
│   ├── system-architecture.md # Describes the overall system architecture and data flow.
│   └── dev-rules.md      # Defines coding standards and development guidelines.
│
├── node_modules/         # Contains installed Node.js dependencies (ignored by Git).
│
├── public/               # (Obsolete) Contained old frontend static assets. No longer used; Grafana is the frontend.
│   ├── index.html        # (Obsolete)
│   ├── app.ts            # (Obsolete)
│   └── dist/             # (Obsolete)
│
├── scripts/              # Contains utility and management scripts.
│   ├── ingest_lexicon.ts # Script to ingest the NRC lexicon from file into the database.
│   ├── manage_filters.ts # Script for managing complex keyword filters in the database.
│   └── manage_lexicon.ts # Script for managing lexicon emotions and word associations in the DB.
│
├── src/                  # Contains backend TypeScript source code.
│   ├── server.ts         # Main backend application: initializes DB, Firehose, aggregation, state.
│   ├── firehose.ts       # Older firehose client (may be superseded by firehoseHandler.ts or parts integrated).
│   ├── sentiment.ts      # Handles lexicon loading (from DB) and sentiment analysis logic.
│   ├── types.ts          # Defines TypeScript types and interfaces used across the backend.
│   ├── parse-repo.ts     # Utilities for parsing repository data from Firehose events.
│   ├── franc.d.ts        # Type declaration for 'franc' library (language detection).
│   ├── multiformats.d.ts # Type declaration for 'multiformats' library.
│   │
│   └── server/           # Core backend services and logic.
│       ├── config.ts     # Backend configuration (e.g., aggregation intervals, MA windows).
│       ├── db.ts         # Database connection, schema initialization, data loading functions (e.g., `loadRecentMAStates`).
│       ├── state.ts      # Manages in-memory application state (accumulators, MA states, signals).
│       ├── aggregation.ts  # Core data aggregation logic (`aggregateAndStore` function), stores data in `sentiment_metrics`.
│       ├── firehoseHandler.ts # Handles connection to Bluesky Firehose, post processing, and sentiment scoring.
│       ├── httpServer.ts   # (Largely Obsolete) Sets up a basic HTTP server; most API/frontend serving removed.
│       └── sentimentUtils.ts # Utility functions for sentiment calculations and MA state management.
│
├── NRC Emotion Lexicon.zip # (Obsolete) Original lexicon archive.
├── screenshot.png        # (Obsolete) Screenshot of the old frontend.
└── ... (other project files like jest.config.cjs, api-review.md, backlog.md)
```

## Key Components (Current Focus for Grafana):

*   **Backend (`src/` and `src/server/`):** Written in TypeScript, runs on Node.js. Responsible for:
    *   Fetching data from the Bluesky Firehose (`src/server/firehoseHandler.ts`).
    *   Performing sentiment analysis using a DB-backed lexicon (`src/sentiment.ts`).
    *   Aggregating sentiment scores and post counts (`src/server/aggregation.ts`).
    *   Storing normalized metric data (`raw_value`, MAs) in the `sentiment_metrics` table in PostgreSQL (`src/server/db.ts`, `src/server/aggregation.ts`).
    *   Managing application state (`src/server/state.ts`).
*   **Database (PostgreSQL):** Managed via `docker-compose.yml`. Stores:
    *   `sentiment_metrics`: Normalized time-series data for Grafana.
    *   Lexicon tables: `lexicon_languages`, `lexicon_emotions`, `lexicon_words`, `word_emotion_associations`.
    *   `complex_keyword_filters`: Definitions for keyword-based filtering.
*   **Grafana:** Runs as a separate service defined in `docker-compose.yml`. Connects to PostgreSQL to visualize data from `sentiment_metrics`.
*   **Scripts (`scripts/`):** For managing database content like the lexicon and filters.
*   **Deployment (`Dockerfile`, `fly.toml`):** Configured for deployment on Fly.io.
*   **Documentation (`docs/`):** Contains planning, architecture, setup, and this structure outline.

This provides an updated overview focusing on the current backend-Grafana architecture. 