import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { disposeFakeServices } from "./fakeServices.ts";

// Unmount rendered trees between tests (vitest runs without injected globals), and stop the
// fake cores they used.
afterEach(() => {
  cleanup();
  disposeFakeServices();
});
