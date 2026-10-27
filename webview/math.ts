import katex from "katex";

export function normalizeMathSource(source: string): string {
  const options = { throwOnError: true, trust: false, displayMode: true };
  // Markdown-authored formulas can double every TeX command. KaTeX accepts
  // \\ge as a line break plus letters, so parsing the original is not a guard.
  const escapes = [...source.matchAll(/\\+(?=[a-zA-Z{}])/g)];
  if (
    /\\{2}(?:[a-zA-Z]{2,}|[{}])/.test(source) &&
    escapes.every(([slashes]) => slashes.length % 2 === 0)
  ) {
    const decoded = source.replace(/\\{2,}/g, (slashes) =>
      slashes.length % 2 ? slashes : slashes.slice(slashes.length / 2),
    );
    try {
      katex.renderToString(decoded, options);
      return decoded;
    } catch {
      // Keep unknown commands readable and try the mixed-escape repair below.
    }
  }
  // Some Accoding statements mix ordinary TeX with doubled environment escapes.
  const candidate = source.replace(
    /\\\\begin\{([a-zA-Z]+\*?)\}[\s\S]*?\\\\end\{\1\}/g,
    (environment) =>
      environment.replace(/\\{2,}/g, (slashes: string) =>
        slashes.length % 2 ? slashes : slashes.slice(slashes.length / 2),
      ),
  );
  if (candidate === source) return source;
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
