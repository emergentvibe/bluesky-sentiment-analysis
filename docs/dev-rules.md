# Development Rules and Guidelines

This document outlines the development rules, conventions, and best practices for the Bluesky Real-time Sentiment Dashboard project. Adhering to these guidelines ensures code consistency, maintainability, and quality, especially as the project incorporates more complex features like signal composition and custom metrics.

## 1. General Principles

*   **Consistency:** Strive for consistency in coding style, naming, and architectural patterns throughout the codebase.
*   **Clarity:** Write clear, readable, and understandable code. Prioritize maintainability over overly clever optimizations unless performance is a proven bottleneck.
*   **Simplicity (KISS):** Keep things as simple as possible, but no simpler. Avoid unnecessary complexity.
*   **Modularity:** Design components (backend modules, frontend functions) with clear responsibilities and minimal coupling.
*   **Documentation:** Maintain essential documentation (`dev-plan.md`, `system-architecture.md`) and add comments to explain complex or non-obvious code sections.

## 2. Version Control (Git)

*   **Commits:** Make atomic commits that represent a single logical change.
*   **Commit Messages:** Write clear and descriptive commit messages (e.g., using conventional commits format: `feat: Add keyword filtering to post processor`).
*   **Branching:** Use feature branches for significant changes or new features. Merge branches back into the main branch upon completion (via Pull Requests if collaborating).
*   **`.gitignore`:** Ensure build artifacts (`/dist`, `/node_modules`), environment files (`.env`), and OS-specific files are ignored.

## 3. Code Formatting & Linting

*   **Tools:** Utilize Prettier for automatic code formatting and ESLint for identifying potential code style issues and errors.
*   **Configuration:** Ensure editor integration is set up to format on save or use pre-commit hooks. (Configuration files for these tools should be added if not present).
*   **Goal:** Maintain a consistent code style across the entire project automatically.

## 4. TypeScript Usage

*   **Strict Mode:** Enable TypeScript's `strict` mode in `tsconfig.json` (or specific strict flags like `strictNullChecks`, `noImplicitAny`).
*   **Typing:**
    *   Provide explicit types for function parameters, return values, and variables where inference is not clear or sufficient.
    *   Prefer `interface` for defining the shape of objects, especially for API contracts (WebSocket messages).
    *   Use `type` for defining aliases, unions, intersections, or more complex type shapes.
    *   Use `enum` for fixed sets of related constants (e.g., WebSocket message type strings, although string literals union types are also acceptable).
    *   Avoid `any` where possible. Use `unknown` and type guards if the type is truly unknown initially. Use `as any` sparingly and only as a last resort, often indicating a place where type definitions could be improved.
*   **Readonly:** Use the `readonly` modifier for properties that should not be reassigned after object creation where applicable.
*   **Utility Types:** Leverage built-in utility types like `Partial`, `Readonly`, `Pick`, `Omit` where appropriate.

## 5. Backend Development (Node.js/TypeScript)

*   **Modules:** Use ES Modules (`import`/`export`) syntax consistently. Ensure correct relative path imports (`./module.js`).
*   **Asynchronous Operations:** Use `async`/`await` for all asynchronous operations (DB queries, file system access, potentially some complex computations). Avoid raw Promises (`.then()`, `.catch()`) unless necessary for specific patterns.
*   **Error Handling:**
    *   Use `try...catch` blocks around `await` calls that might throw errors (especially I/O like DB access).
    *   Log errors with sufficient context (e.g., function name, relevant parameters).
    *   Do not swallow errors silently. Propagate them or handle them appropriately.
*   **Environment Variables:** Use `dotenv` and a `.env` file for configuration (Database URL, ports, API keys, etc.). Do *not* commit `.env` files. Provide a `.env.example` file. Access variables via `process.env`.
*   **Modularity:** As planned in "Future Enhancements", break down `server.ts` into smaller, focused modules (e.g., `db.ts`, `websocketApi.ts`, `aggregation.ts`, `composition.ts`).
*   **Dependencies:** Minimize dependencies. Choose well-maintained libraries.

## 6. Database (PostgreSQL / `pg` library)

*   **Connection Pooling:** Always use `pg.Pool` for managing database connections. Do not create individual `pg.Client` instances per request.
*   **Parameterized Queries:** **Always** use parameterized queries (`pool.query('SELECT * FROM users WHERE id = $1', [userId])`) to prevent SQL injection vulnerabilities. Do *not* use string concatenation or template literals to insert values directly into SQL queries.
*   **Schema Management:**
    *   Define table schemas clearly (as started in `system-architecture.md`).
    *   For future schema changes required by new features (like keyword storage or custom metrics), implement a migration strategy (either manually tracked SQL scripts or using a dedicated migration tool like `node-pg-migrate`).
*   **Naming Conventions:** Use `snake_case` for table and column names (e.g., `sentiment_data`, `post_count`).
*   **Error Handling:** Wrap database calls in `try...catch` and handle potential errors (connection errors, query errors).

## 7. Frontend Development (TypeScript / DOM / Chart.js)

*   **DOM Access:** Minimize direct DOM manipulation. Cache frequently accessed element references (e.g., chart canvases, control elements) in variables instead of querying the DOM repeatedly.
*   **Event Handling:** Use event listeners appropriately. Consider event delegation for handling events on multiple similar elements (though less critical with the current simpler UI).
*   **WebSocket Handling:**
    *   Implement robust connection state management (connecting, open, closed, error).
    *   Include reconnection logic.
    *   Use `try...catch` when parsing incoming JSON messages.
    *   Validate the structure of received messages (even basic type checks) before processing.
*   **Chart.js:**
    *   Update charts efficiently using `chart.update('none')` or `chart.update()` without arguments unless specific animations are desired.
    *   Manage datasets dynamically by adding/removing them from the `chart.data.datasets` array rather than destroying and recreating the entire chart instance unless necessary.
    *   Ensure chart instances are properly destroyed if the corresponding canvas is removed from the DOM.
*   **State Management:** Keep UI state (`plottedSignals`, `currentTimeWindowMs`) separate from rendering logic. Update the state first, then re-render the relevant UI parts (chart, signal list).
*   **Persistence (Planned):** Use browser Local Storage for storing simple user preferences like the list of `signalId`s to display. Be mindful of storage limits and store only necessary identifiers, not large amounts of data.

## 8. API Design (WebSocket Messages)

*   **Clarity:** Define clear, explicit message types using TypeScript interfaces for both client-to-server and server-to-client communication (as started in `system-architecture.md`).
*   **Versioning (Future):** Consider adding a version field to messages if significant breaking changes are anticipated.
*   **Targeted vs. Broadcast:** Favor targeted messages over broadcasting where possible, especially for live updates, as planned in the API refactor. Define clear subscription mechanisms (`subscribeSignal`/`unsubscribeSignal`).
*   **Payloads:** Keep payloads concise and focused on the necessary data for the specific message type.

## 9. Logging

*   **Levels:** Use appropriate log levels (e.g., `console.debug`, `console.info`, `console.warn`, `console.error`).
*   **Context:** Include relevant context in log messages (e.g., function name, user ID [if applicable], relevant data identifiers).
*   **Production:** Reduce log verbosity in production (e.g., disable debug logs). Avoid logging sensitive information (passwords, raw API keys). Use environment variables to control log levels.

## 10. Testing (Future Goal)

*   **Unit Tests:** Aim for unit tests for critical backend logic, especially:
    *   Sentiment analysis (`sentiment.ts`).
    *   Data aggregation and MA calculation.
    *   (Planned) Signal composition logic.
*   **Integration Tests:** Consider basic tests for:
    *   API endpoint/message handling.
    *   Database interactions.
*   **Tools:** Use a testing framework like Jest or Vitest.

## 11. Documentation Updates

*   **Essential:** Keep `dev-plan.md` and `system-architecture.md` **up-to-date** as features are implemented or architectural decisions change. These are crucial for understanding the project's state and direction.
*   **Code Comments:** Add comments primarily to explain the *why* behind complex code, not just the *what*. Explain non-obvious logic, workarounds, or important assumptions. 