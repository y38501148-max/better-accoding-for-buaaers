import katex from "katex";

export function normalizeMathSource(source: string): string {
  // Some Accoding statements mix ordinary TeX with doubled environment escapes.
  const candidate = source.replace(
    /\\\\begin\{([a-zA-Z]+\*?)\}[\s\S]*?\\\\end\{\1\}/g,
    (environment) =>
      environment.replace(/\\{2,}/g, (slashes: string) =>
        slashes.length % 2 ? slashes : slashes.slice(slashes.length / 2),
      ),
  );
  if (candidate === source) return source;
  const options = { throwOnError: true, trust: false, displayMode: true };
  try {
    katex.renderToString(source, options);
    return source;
  } catch {
    try {
      katex.renderToString(candidate, options);
      return candidate;
    } catch {
      return source;
    }
  }
}
