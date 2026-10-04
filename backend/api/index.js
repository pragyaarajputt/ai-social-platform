// Vercel entry point: the whole Express API as one serverless function. Every request is routed here
// (see vercel.json). Uses the compiled app in dist/, which Vercel's build command creates first.
// Elsewhere (Railway, a server, local) the API runs as a normal server instead: npm start.
export { app as default } from "../dist/app.js";
