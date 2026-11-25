import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount rendered trees between tests (vitest runs without injected globals).
afterEach(() => {
  cleanup();
});
