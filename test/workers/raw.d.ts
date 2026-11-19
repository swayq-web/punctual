// Vite's `?raw` import: the file's text. Used to read the wrangler configs
// SwayQ deploys (swayq-no-upstream.test.ts).
declare module '*.toml?raw' {
  const text: string
  export default text
}
