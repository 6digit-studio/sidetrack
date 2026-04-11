/**
 * Browser entry point - auto-initializes sidetrack
 * 
 * Include via <script src="http://localhost:6274/sidetrack.js"></script>
 * Or load from the built dist/sidetrack.js
 */

import { init } from './index';

// Auto-initialize and expose globally
const instance = init();

// Expose on window for debugging
if (typeof window !== 'undefined') {
  (window as any).__sidetrack = instance;
}

export default instance;
