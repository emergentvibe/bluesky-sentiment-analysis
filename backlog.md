# Bluesky Sentiment Analysis Dashboard - Project Backlog

This document tracks planned features, enhancements, and tasks for the project. Community contributions are welcome! Please feel free to open an issue or pull request related to these items.

## Core Functionality & Data

- **Expand Lexicon:** The current NRC lexicon is limited (~1400 words) and basic.
    - ✅ **Multilingual NRC Lookup:** Create a structured lookup table mapping words to emotions/sentiments based on the full NRC Emotion Lexicon across all its supported languages.
    - **Emoji Integration:** 
        - Incorporate an emoji sentiment lexicon (e.g., Emoji Sentiment Ranking) or model.
        - Map emojis found in posts to relevant sentiment scores.
    - **Frequency-Based Expansion (Neologisms/Slang):**
        - Implement frequency analysis on processed post text (all languages).
        - Identify high-frequency words *not* present in the existing lexicon.
        - Develop a process (manual review, LLM-aided scoring, community contribution?) to add these relevant neologisms, slang terms, and domain-specific words to the expanded lexicon.
    - ✅ **Add New Dimensions:** 
        - Research and define additional relevant dimensions beyond NRC emotions (e.g., "belief", "political-left", "political-right", "financial-sentiment", "toxicity", "formality").
        - Use LLMs or other methods (e.g., manual annotation, transfer learning) to generate scores for existing *and* new lexicon words across these new dimensions.
    - **Weighted Dimension Scoring:** 
        - Transition from simple presence/absence scoring to weighted scores (0-1) for each word across *all* dimensions (NRC + new).
        - Update the `analyzeSentiment` function to use these weighted scores.
    - ⚙️ **Keyword Filtering:** (in progress) Allow users to define custom filters based on keywords/phrases.
        - **Username List Filtering:** Allow filtering posts based on inclusion/exclusion of authors from specific user-provided lists.

- **Integrate Twitter Firehose:** Connect to the Twitter firehose (e.g., via Community Archive or other available APIs) to allow cross-platform comparison.

- **Custom Bluesky Feeds:** Create dedicated feeds within Bluesky showcasing posts ranking highly for specific emotions (e.g., "Anger Feed", "Joy Feed").

- **Spike/Deviation Detection & Bot Posting:** 
    - Implement algorithms to detect significant shifts or anomalies in specific sentiment dimensions or keywords.
    - Create a bot that automatically posts alerts about detected spikes/deviations to Bluesky and/or Twitter.

- **LLM Summaries:** Generate concise summaries (e.g., for the last hour) for each dimension, highlighting key topics or posts contributing to the current sentiment levels.

- **Open API:** Develop and document a public API endpoint to provide access to the live aggregated sentiment data.

## Advanced Analysis & Visualization

- **Grammar Field / Memeome Analysis:** 
    - Perform frequency analysis on words/phrases beyond the core lexicon.
    - Track the rise and fall of popular terms/memes over time.
    - Automatically suggest or add frequently occurring high-sentiment words to the lexicon.
- **Filter by Engagement & Embeddings:**
    - Allow filtering or weighting scores based on post engagement (likes, reposts).
    *   Generate embeddings for high-engagement posts.
    *   Visualize post embeddings using techniques like Self-Organizing Maps (SOM) or t-SNE/UMAP.
- **Heatmap Visualization:** Create a geographic heatmap for sentiment dimensions. (Note: This relies on the often inaccurate assumption that language implies location).

## Technical Debt & Refactoring

- **Testing Coverage:** Add comprehensive unit and integration tests for backend logic (sentiment, aggregation, DB interaction) and frontend components/WebSocket communication.
- **Configuration Management:** Move more configuration (aggregation intervals, MA windows, throttle factors) to environment variables or a dedicated config file.
- **Error Handling:** Implement more robust and specific error handling throughout the backend (firehose, DB, sentiment analysis).
- **Logging:** Implement structured logging (e.g., Winston, Pino) for better monitoring and debugging.
- **Robust Static Serving:** Replace the basic Node HTTP file serving with a more standard approach (e.g., `express.static`).
- **Firehose Reconnection Logic:** Improve the resilience of the firehose connection in `src/firehose.ts`. 