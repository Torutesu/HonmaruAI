import base from "./playwright.config";

// The screenshot rig, run on demand: same relay and fixtures as the E2E
// suite, but the shots are the output rather than the assertions.
export default { ...base, testIgnore: undefined, testMatch: /screens\.spec\.ts/ };
