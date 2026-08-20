// Vercel Speed Insights Integration
// This script initializes Vercel Speed Insights for the application

import { injectSpeedInsights } from '../node_modules/@vercel/speed-insights/dist/index.mjs';

// Initialize Speed Insights
injectSpeedInsights({
  debug: false, // Set to true for development debugging
  framework: 'vanilla-js'
});
