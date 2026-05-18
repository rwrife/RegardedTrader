import '@testing-library/react';

// React 18's act() integration looks for this global to confirm the test
// environment is wired up correctly. Without it we still pass, but every
// render logs a noisy "not configured to support act(...)" warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
