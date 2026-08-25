/**
 * Chalk-style terminal colouring without the dependency. Respects
 * `NO_COLOR` and non-TTY stdout (piped logs stay clean), which is what a
 * backbone node's journal should look like anyway.
 */

const enabled = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const code = (open: string, text: string): string =>
  enabled() ? `\x1b[${open}m${text}\x1b[0m` : text;

export const c = {
  bold: (t: string): string => code('1', t),
  dim: (t: string): string => code('2', t),
  red: (t: string): string => code('31', t),
  green: (t: string): string => code('32', t),
  yellow: (t: string): string => code('33', t),
  cyan: (t: string): string => code('36', t),
};

/** Colourises one output line by its shape. Unknown lines pass through
 * dimmed-free; the test harness never hits this (it injects onLine). */
export function paintLine(line: string): string {
  if (line.includes('PEERS_NODES=')) return c.bold(c.yellow(line));
  if (line.startsWith('listening:') || line.startsWith('announcing:')) return c.green(line);
  if (line.startsWith('peers node peer id:')) {
    const [head, ...rest] = line.split(': ');
    return c.dim(`${head}:`) + c.cyan(` ${rest.join(': ')}`);
  }
  if (line.startsWith('peers node identity:')) return c.dim(line);
  if (line.startsWith('peers node is up.')) return c.bold(c.green(line));
  if (line.startsWith('dialing known node:')) return c.dim(line);
  if (line.startsWith('  →')) return c.dim(line);
  // banner / boxed info — already painted before log(), keep as-is
  if (line.startsWith('  peers') || line.startsWith('  ┌') || line.startsWith('  └') || line.startsWith('  │')) return line;
  return line;
}
