import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Values substituted into `{{token}}` placeholders. */
export type TemplateValues = Record<string, string>;

/** Directory names that are never part of a scaffolded project. */
const IGNORED = new Set(['.git', 'node_modules']);

/** Matches a `{{token}}` placeholder, tolerating surrounding whitespace. */
const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Replaces every `{{token}}` whose name is present in `values`.
 *
 * Unknown tokens are left untouched, so a template can carry literal
 * `{{...}}` (e.g. in documentation about the templating itself) without error.
 */
export function renderTemplate(contents: string, values: TemplateValues): string {
  return contents.replace(TOKEN_PATTERN, (match, name: string) => values[name] ?? match);
}

/**
 * Recursively copies `source` into `destination`, skipping VCS and install
 * directories so a template's own history never leaks into the scaffold.
 */
export async function copyTemplate(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTemplate(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

/** A file with a NUL byte is treated as binary and copied through verbatim. */
function isBinary(contents: Buffer): boolean {
  return contents.includes(0);
}

/**
 * Interpolates `values` into every text file under `root`, in place.
 *
 * Binary files and ignored directories are left alone. Returns the written
 * files' paths relative to `root`, using forward slashes and sorted, so the
 * result is stable across platforms.
 */
export async function renderDirectory(root: string, values: TemplateValues): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) {
        continue;
      }
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const contents = await readFile(full);
        if (!isBinary(contents)) {
          const text = contents.toString('utf8');
          const rendered = renderTemplate(text, values);
          if (rendered !== text) {
            await writeFile(full, rendered, 'utf8');
          }
        }
        files.push(relative(root, full).split(sep).join('/'));
      }
    }
  }

  await walk(root);
  return files.sort();
}
