/** DEMO BUILD ONLY. Stubs for node:fs / node:path / server-only (never called in the browser demo). */
const unavailable = () => {
  throw new Error("Not available in the browser demo.");
};
export const existsSync = () => false;
export const readFileSync = unavailable;
export const appendFileSync = unavailable;
export const mkdirSync = unavailable;
export const writeFileSync = unavailable;
export const dirname = (p: string) => p.split("/").slice(0, -1).join("/");
export const join = (...p: string[]) => p.join("/");
export default { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, dirname, join };
