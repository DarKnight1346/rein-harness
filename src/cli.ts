#!/usr/bin/env node
/**
 * Entry point. React and Ink must run their production builds: React's development build records a
 * `performance.measure` on every render into a buffer that only grows (a memory leak over a long
 * session, and Node's "MaxPerformanceEntryBufferExceeded" warning printed over the UI) and prints
 * development warnings onto the screen. They choose the build from NODE_ENV when first loaded, so it
 * is set for that moment only and then restored: commands the agent runs must keep the user's own
 * NODE_ENV (`npm install` skips devDependencies under "production").
 */
const userNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
await import('react');
await import('react/jsx-runtime');
await import('ink');
if (userNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = userNodeEnv;
await import('./app.js');
