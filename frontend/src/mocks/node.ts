import { setupServer } from "msw/node";
import { handlers } from "./handlers";

// Used by vitest (and Playwright global setup) so unit/visual tests hit the same
// fixtures as the browser worker.
export const server = setupServer(...handlers);
